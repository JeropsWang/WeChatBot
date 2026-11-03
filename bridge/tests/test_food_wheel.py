import json
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from render_food_wheel import render, inspect_image


class FoodWheelTests(unittest.TestCase):
    def test_selected_food_after_40_remains_visible_and_snapshot_is_deterministic(self):
        foods = [{"id": str(i), "name": "测试菜品 " + str(i)} for i in range(47)]
        payload = {"food": foods[-1], "candidates": foods}
        with tempfile.TemporaryDirectory(
            prefix="liino-wheel-", dir=Path(__file__).resolve().parents[2] / "artifacts"
        ) as directory:
            first, second = Path(directory) / "first.png", Path(directory) / "second.png"
            result = render(payload, first)
            render(payload, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(result["renderedSlices"], 40)
            with Image.open(first) as image:
                self.assertEqual(image.size, (900, 900))
                self.assertEqual(image.info["SelectedFood"], foods[-1]["name"])
                self.assertEqual(
                    json.loads(image.info["Candidates"]), [food["name"] for food in foods]
                )
                self.assertEqual(image.getpixel((450, 165)), (66, 90, 61))

    def test_invalid_raster_cannot_be_validated_by_its_magic_only(self):
        import base64

        with self.assertRaises(Exception):
            inspect_image(
                {
                    "mimeType": "image/png",
                    "data": base64.b64encode(b"\x89PNG\r\n\x1a\nnot-an-image").decode(),
                }
            )


if __name__ == "__main__":
    unittest.main()
