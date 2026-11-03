# 生成本地互动图片，不包含管理员凭据；发送仍经过正常附件与发送账本。
"""Render actual food candidates, or validate uploaded raster bytes. No network or model use."""
import base64
import io
import json
import math
import os
import sys
import warnings
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)


def font(size):
    choices = [
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyh.ttc",
        Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/msyhbd.ttc",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ]
    for choice in choices:
        if choice.is_file():
            return ImageFont.truetype(str(choice), size)
    return ImageFont.load_default(size=size)


def clipped(draw, text, face, width):
    if draw.textlength(text, font=face) <= width:
        return text
    while text and draw.textlength(text + "…", font=face) > width:
        text = text[:-1]
    return text + "…"


def inspect_image(payload):
    data = base64.b64decode(payload["data"], validate=True)
    if not data or len(data) > 5 * 1024 * 1024:
        raise ValueError("invalid image size")
    expected = {"image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WEBP"}[
        payload["mimeType"]
    ]
    with Image.open(io.BytesIO(data)) as image:
        if (
            image.format != expected
            or image.width < 1
            or image.height < 1
            or image.width * image.height > Image.MAX_IMAGE_PIXELS
        ):
            raise ValueError("invalid image header")
        dimensions = image.size
        image.verify()
    # Decode the first real frame too; magic bytes alone are insufficient.
    with Image.open(io.BytesIO(data)) as image:
        image.load()
    return {"format": expected, "width": dimensions[0], "height": dimensions[1]}


def render(payload, output):
    foods, selected = payload["candidates"], payload["food"]
    selected_index = next(
        i
        for i, food in enumerate(foods)
        if (
            food.get("id") == selected["id"]
            if selected.get("id")
            else food["name"] == selected["name"]
        )
    )
    indices = list(range(len(foods)))
    if len(foods) > 40:
        indices = [i for i in indices if i != selected_index][:38] + [selected_index]
    slices = [
        {"name": foods[i]["name"], "weight": 1, "selected": i == selected_index} for i in indices
    ]
    if len(foods) > len(indices):
        slices.append(
            {
                "name": "其他 " + str(len(foods) - len(indices)) + " 道",
                "weight": len(foods) - len(indices),
                "selected": False,
            }
        )
    position = 0
    for item in slices:
        if item["selected"]:
            break
        position += item["weight"]
    start = 270 - 360 * (position + 0.5) / len(foods)
    image = Image.new("RGB", (900, 900), "#fffaf0")
    draw = ImageDraw.Draw(image)
    draw.text((450, 35), "今天吃什么", anchor="mm", font=font(34), fill="#353e32")
    draw.text(
        (450, 83),
        clipped(draw, "抽中：" + selected["name"], font(25), 800),
        anchor="mm",
        font=font(25),
        fill="#425a3d",
    )
    cx, cy, radius = 450, 475, 340
    colors = ["#eedfbd", "#dbe3cd", "#e8cdbd", "#d9e2df", "#e8dfc6"]
    face = font(18 if len(slices) <= 16 else 12)
    for index, item in enumerate(slices):
        end = start + 360 * item["weight"] / len(foods)
        draw.pieslice(
            (cx - radius, cy - radius, cx + radius, cy + radius),
            start,
            end,
            fill="#425a3d" if item["selected"] else colors[index % len(colors)],
            outline="#fffaf0",
            width=3,
        )
        middle = math.radians((start + end) / 2)
        x, y = cx + math.cos(middle) * radius * 0.72, cy + math.sin(middle) * radius * 0.72
        width = 150 if len(slices) <= 16 else 84
        draw.text(
            (x, y),
            clipped(draw, item["name"], face, width),
            anchor="mm",
            font=face,
            fill="white" if item["selected"] else "#353e32",
        )
        start = end
    draw.ellipse(
        (cx - 110, cy - 110, cx + 110, cy + 110), fill="#fffaf0", outline="#425a3d", width=4
    )
    draw.text((cx, cy - 30), "本次抽中", anchor="mm", font=font(21), fill="#68745b")
    winner = selected["name"]
    winner_face = font(26)
    draw.text(
        (cx, cy + 10),
        clipped(draw, winner, winner_face, 195),
        anchor="mm",
        font=winner_face,
        fill="#283d27",
    )
    draw.polygon([(cx - 15, 117), (cx + 15, 117), (cx, 151)], fill="#b75a3e")
    draw.text(
        (450, 858),
        "共 " + str(len(foods)) + " 道候选 · 等概率抽签",
        anchor="mm",
        font=font(21),
        fill="#68745b",
    )
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("SelectedFood", selected["name"])
    metadata.add_text("CandidateCount", str(len(foods)))
    metadata.add_text(
        "Candidates", json.dumps([food["name"] for food in foods], ensure_ascii=False)
    )
    image.save(output, format="PNG", pnginfo=metadata)
    return {
        "width": 900,
        "height": 900,
        "selectedFood": selected["name"],
        "candidateCount": len(foods),
        "renderedSlices": len(slices),
    }


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        result = (
            inspect_image(payload) if sys.argv[1] == "--inspect" else render(payload, sys.argv[1])
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        # The caller deliberately exposes a fixed error, never image bytes or input data.
        sys.exit(1)
