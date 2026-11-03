"""Matching contracts: real vector calculations, without downloading a model."""
import json
import math
import os
import subprocess
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image_match import cosine_similarity, match_features, match_request


class ImageMatchTests(unittest.TestCase):
    def test_cosine_is_normalized_not_a_dot_product(self):
        self.assertAlmostEqual(cosine_similarity([3, 4], [0, 7]), 0.8)
        self.assertEqual(cosine_similarity([2, 0], [-5, 0]), -1)

    def test_only_scores_strictly_above_threshold_trigger(self):
        refs = [{"id": "a", "category": "奶娃", "features": [0.6, 0.8]}]
        self.assertFalse(match_features([1, 0], refs, threshold=0.6)["trigger"])
        self.assertTrue(match_features([1, 0], refs, threshold=0.59)["trigger"])

    def test_selects_best_reference_and_keeps_its_category(self):
        refs = [
            {"id": "other", "category": "other", "features": [0, 1]},
            {"id": "yellow", "category": "奶娃", "features": [1, 0]},
        ]
        result = match_features([1, 0], refs)
        self.assertEqual(result["matchedReference"], "yellow")
        self.assertEqual(result["category"], "奶娃")
        self.assertEqual(result["similarity"], 1)
        self.assertTrue(result["trigger"])

    def test_leave_one_out_does_not_match_the_query_to_itself(self):
        refs = [
            {"id": "self", "category": "奶娃", "features": [1, 0]},
            {"id": "different", "category": "奶娃", "features": [0, 1]},
        ]
        result = match_features([1, 0], refs, exclude_ids={"self"})
        self.assertFalse(result["trigger"])
        self.assertEqual(result["matchedReference"], "different")

    def test_empty_gallery_never_triggers(self):
        result = match_features([1, 0], [])
        self.assertFalse(result["trigger"])
        self.assertIsNone(result["similarity"])

    def test_invalid_vectors_and_thresholds_are_rejected(self):
        for a, b in [([], []), ([0, 0], [1, 0]), ([1], [1, 2]), ([math.nan], [1]), ([math.inf], [1])]:
            with self.subTest(a=a, b=b), self.assertRaises(ValueError):
                cosine_similarity(a, b)
        for threshold in [-0.1, 1.1, math.nan]:
            with self.subTest(threshold=threshold), self.assertRaises(ValueError):
                match_features([1, 0], [], threshold=threshold)

    def test_cli_emits_utf8_json_even_on_non_utf8_windows_console(self):
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "image_match.py"),
                   "match", "--manifest", "不存在的样图库.json", "--image", "unused.png"]
        completed = subprocess.run(command, capture_output=True,
                                   env={**os.environ, "PYTHONIOENCODING": "ascii"})
        self.assertNotEqual(completed.returncode, 0)
        result = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["trigger"])
        self.assertIn("不存在的样图库", result["error"])

    def test_resident_request_rejects_changed_bytes_before_model_encoding(self):
        import hashlib
        from PIL import Image
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2] / "artifacts") as folder:
            path = Path(folder) / "image.png"
            Image.new("RGB", (2, 2), "yellow").save(path)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            path.write_bytes(path.read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "content changed"):
                match_request({"id": "request-1", "path": str(path), "sha256": digest}, [], None)


if __name__ == "__main__":
    unittest.main()
