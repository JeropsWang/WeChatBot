import unittest
from PIL import Image, ImageDraw, ImageEnhance
from avatar_descriptor import describe_avatar


class AvatarDescriptorTests(unittest.TestCase):
    def test_small_render_variations_keep_descriptor_nearby(self):
        image = Image.new('RGB', (54, 54), (40, 50, 70))
        draw = ImageDraw.Draw(image)
        draw.ellipse((6, 3, 46, 48), fill=(210, 150, 80))
        draw.rectangle((10, 17, 21, 22), fill=(10, 10, 30))
        draw.rectangle((33, 17, 43, 22), fill=(10, 10, 30))
        original = describe_avatar(image)
        for changed in (
            image.resize((56, 56), Image.Resampling.BILINEAR),
            ImageEnhance.Brightness(image).enhance(1.01),
        ):
            other = describe_avatar(changed)
            self.assertLessEqual(
                (int(original['hash'], 16) ^ int(other['hash'], 16)).bit_count(), 8
            )
            self.assertLessEqual(
                max(abs(a - b) for a, b in zip(original['colors'], other['colors'])), 20
            )
