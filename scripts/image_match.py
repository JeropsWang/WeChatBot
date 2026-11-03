"""Local OpenCLIP experiment. Emits JSON; never calls an LLM or sends chat messages."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import re
from pathlib import Path
import sys
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "ViT-B-32"
DEFAULT_PRETRAINED = "laion2b_s34b_b79k"


def cosine_similarity(a: Iterable[float], b: Iterable[float]) -> float:
    a, b = list(a), list(b)
    if not a or len(a) != len(b) or not all(math.isfinite(x) for x in a + b):
        raise ValueError("Features must be nonempty, finite, and have equal dimensions")
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b))
    if not math.isfinite(norm) or norm == 0:
        raise ValueError("Feature norm must be finite and nonzero")
    return max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b)) / norm))


def match_features(query, references, threshold=0.75, exclude_ids=None):
    if not math.isfinite(threshold) or not 0 <= threshold <= 1:
        raise ValueError("Threshold must be between 0 and 1")
    # Validate the query even if the gallery is empty.
    cosine_similarity(query, query)
    excluded = set(exclude_ids or ())
    matches = sorted(
        [{"referenceId": ref["id"], "category": ref["category"],
          "similarity": cosine_similarity(query, ref["features"])}
         for ref in references if ref["id"] not in excluded],
        key=lambda item: (-item["similarity"], item["referenceId"]),
    )
    best = matches[0] if matches else None
    return {
        "status": "ok", "metric": "cosine_similarity", "calibrated": False,
        "similarity": best["similarity"] if best else None,
        "threshold": threshold, "comparison": ">",
        "trigger": bool(best and best["similarity"] > threshold),
        "matchedReference": best["referenceId"] if best else None,
        "category": best["category"] if best else None,
        "matches": matches[:5],
    }


def load_manifest(path):
    path = Path(path).resolve()
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    references = document.get("references", [])
    if not references or len(references) > 500:
        raise ValueError("Gallery must contain between 1 and 500 reference images")
    seen = set()
    for ref in references:
        if not isinstance(ref.get("id"), str) or not ref["id"] or ref["id"] in seen:
            raise ValueError("Reference IDs must be unique nonempty strings")
        if not isinstance(ref.get("category"), str) or not ref["category"]:
            raise ValueError("Reference category is required")
        seen.add(ref["id"])
        ref["path"] = str((path.parent / ref["path"]).resolve())
    return references


def read_image(path, crop=None):
    from PIL import Image, ImageOps

    # The experiment intentionally supports static images only.
    with Image.open(path) as source:
        if getattr(source, "n_frames", 1) > 1:
            raise ValueError("Animated images are not supported in this experiment")
        if source.width * source.height > 16_000_000:
            raise ValueError("Image exceeds 16 megapixels")
        image = ImageOps.exif_transpose(source).convert("RGB")
    if crop is not None:
        if (len(crop) != 4 or any(type(v) is not int for v in crop)
                or not 0 <= crop[0] < crop[2] <= image.width
                or not 0 <= crop[1] < crop[3] <= image.height):
            raise ValueError("Crop must be [left, top, right, bottom] inside the image")
        image = image.crop(crop)
    return image


def pixel_digest(image):
    return hashlib.sha256(str(image.size).encode() + image.tobytes()).hexdigest()


class Encoder:
    def __init__(self, args):
        # Keep all downloaded weights inside the project, apart from the bridge env.
        cache = ROOT / "data" / "image-match" / "models"
        cache.mkdir(parents=True, exist_ok=True)
        os.environ["HF_HOME"] = str(cache)
        os.environ["HF_HUB_OFFLINE"] = "0" if args.allow_download else "1"
        import torch
        import open_clip

        self.torch = torch
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        self.device = args.device
        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            args.model, pretrained=args.weights or args.pretrained,
            device=self.device, cache_dir=str(cache),
        )
        self.model.eval()

    def encode(self, images):
        with self.torch.inference_mode():
            # Small batches keep the CPU experiment's peak memory bounded.
            features = []
            for start in range(0, len(images), 4):
                batch = self.torch.stack([self.preprocess(img) for img in images[start:start + 4]])
                values = self.model.encode_image(batch.to(self.device), normalize=True)
                features.extend(values.cpu().float().tolist())
            return features


def prepare_gallery(args):
    references = load_manifest(args.manifest)
    encoder = Encoder(args)
    images, hashes = [], []
    # A user gallery can contain 500 large images. Decode only one encoder batch
    # at a time in the long-lived worker; evaluation still retains its probes.
    for start in range(0, len(references), 4):
        batch = references[start:start + 4]
        decoded = [read_image(ref["path"], ref.get("crop")) for ref in batch]
        for ref, features in zip(batch, encoder.encode(decoded)):
            ref["features"] = features
        if args.command != "serve":
            images.extend(decoded)
            hashes.extend(pixel_digest(image) for image in decoded)
    metadata = {"model": args.model, "pretrained": args.pretrained if not args.weights else "local-weights",
                "device": args.device, "referenceCount": len(references)}
    return references, images, hashes, encoder, metadata


def match_request(request, references, encoder):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str) or not 0 < len(request["id"]) <= 100:
        raise ValueError("Invalid request ID")
    path, digest = request.get("path"), request.get("sha256")
    if not isinstance(path, str) or len(path) > 4096 or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Image path and SHA256 are required")
    from io import BytesIO
    from PIL import Image, ImageOps
    # Decode the exact bytes checked by the service. Never reopen an unchecked file.
    with open(path, "rb") as source:
        data = source.read(5 * 1024 * 1024 + 1)
    if len(data) > 5 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Image content changed or exceeds limit")
    with Image.open(BytesIO(data)) as image:
        if image.width * image.height > 16_000_000 or getattr(image, "n_frames", 1) != 1:
            raise ValueError("Only bounded static images are supported")
        image = ImageOps.exif_transpose(image).convert("RGB")
    return match_features(encoder.encode([image])[0], references)


def serve(args):
    with contextlib.redirect_stdout(sys.stderr):
        references, _, _, encoder, metadata = prepare_gallery(args)
    print(json.dumps({"type": "ready", **metadata}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        request = None
        try:
            if len(line) > 32768:
                raise ValueError("Request exceeds limit")
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                result = match_request(request, references, encoder)
        except Exception:
            result = {"status": "unavailable", "trigger": False}
        print(json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                          "result": result}, ensure_ascii=False, allow_nan=False), flush=True)


def run(args):
    references, images, hashes, encoder, metadata = prepare_gallery(args)
    if args.command == "match":
        image = read_image(args.image, args.crop)
        features = encoder.encode([image])[0]
        return {**match_features(features, references, args.threshold, args.exclude_reference),
                **metadata, "imageSha256": pixel_digest(image), "personaScope": "single-reply"}

    # Evaluate each positive against the other references, excluding exact pixel duplicates.
    rows = []
    for index, ref in enumerate(references):
        exclude = {other["id"] for other, digest in zip(references, hashes) if digest == hashes[index]}
        original = match_features(ref["features"], references, args.threshold, exclude)
        # JPEG loss and downscaling are real image preprocessing probes, not claims
        # about unseen characters or negative classification accuracy.
        from io import BytesIO
        from PIL import Image
        thumbnail = images[index].copy()
        thumbnail.thumbnail((96, 96))
        buffer = BytesIO()
        thumbnail.save(buffer, format="JPEG", quality=50)
        buffer.seek(0)
        with Image.open(buffer) as compressed:
            changed = encoder.encode([compressed.convert("RGB")])[0]
        transformed = match_features(changed, references, args.threshold)
        rows.append({"referenceId": ref["id"], "leaveOneOut": original,
                     "downscaledJpeg": transformed})

    negatives = []
    for path in args.negative:
        image = read_image(path)
        negatives.append({"image": Path(path).name,
                          **match_features(encoder.encode([image])[0], references, args.threshold)})
    # Simple color controls catch gross false triggers but are not character negatives.
    from PIL import Image
    controls = []
    for color in ["white", "black", "yellow", "green"]:
        features = encoder.encode([Image.new("RGB", (224, 224), color)])[0]
        controls.append({"control": "solid-" + color,
                         **match_features(features, references, args.threshold)})
    return {"status": "ok", **metadata, "threshold": args.threshold,
            "calibrated": False, "positiveCount": len(rows),
            "leaveOneOutTriggers": sum(row["leaveOneOut"]["trigger"] for row in rows),
            "downscaledJpegTriggers": sum(row["downscaledJpeg"]["trigger"] for row in rows),
            "negativeCount": len(negatives), "negativeFalseTriggers": sum(row["trigger"] for row in negatives),
            "colorControls": controls, "results": rows, "negatives": negatives,
            "limitations": ["Positive samples alone cannot establish false positive rate.",
                             "Cosine similarity is not a calibrated probability.",
                             "No WeChat messages or external image uploads were performed."]}


def main():
    # stdout is a machine protocol, independent of the Windows console code page.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["match", "evaluate", "serve", "prepare-model"])
    parser.add_argument("--manifest", default=str(ROOT / "data/image-match/references.json"))
    parser.add_argument("--image")
    parser.add_argument("--crop", nargs=4, type=int, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--threshold", type=float, default=0.75)
    parser.add_argument("--exclude-reference", action="append", default=[])
    parser.add_argument("--negative", action="append", default=[])
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--pretrained", default=DEFAULT_PRETRAINED)
    parser.add_argument("--weights", help="Optional local OpenCLIP checkpoint path")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--allow-download", action="store_true", help="Permit downloading public model weights")
    parser.add_argument("--output", help="Also save the JSON result at this path")
    args = parser.parse_args()
    if args.command == "match" and not args.image:
        parser.error("match requires --image")
    if args.command == 'prepare-model':
        Encoder(args)
        print(json.dumps({'status': 'ready', 'model': args.model, 'pretrained': args.pretrained}))
        return
    try:
        if not math.isfinite(args.threshold) or not 0 <= args.threshold <= 1:
            raise ValueError("Threshold must be between 0 and 1")
        if args.command == "serve":
            serve(args)
            return 0
        with contextlib.redirect_stdout(sys.stderr):
            result = run(args)
        output = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(output + "\n", encoding="utf-8")
        print(output)
        return 0
    except Exception as error:
        print(json.dumps({"status": "unavailable", "trigger": False,
                          "error": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
