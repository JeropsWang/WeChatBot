import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gallery_image import normalize
from image_match import prepare_gallery, match_features
from PIL import Image


class GalleryImageTests(unittest.TestCase):
    def test_static_formats_decode_and_thumbnails_contain_without_upscaling(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for fmt, mime in [('PNG', 'image/png'), ('JPEG', 'image/jpeg'), ('WEBP', 'image/webp')]:
                source, output, thumbnail = root / 'source', root / 'out.png', root / 'thumb.png'
                Image.new('RGB', (1000, 200), 'green').save(source, fmt)
                normalize(source, output, thumbnail, mime)
                with Image.open(thumbnail) as image:
                    self.assertEqual(image.size, (320, 64))
                with Image.open(output) as image:
                    self.assertEqual(image.size, (1000, 200))
            Image.new('RGB', (3, 2)).save(source, 'PNG')
            normalize(source, output, thumbnail, 'image/png')
            with Image.open(thumbnail) as image:
                self.assertEqual(image.size, (3, 2))

    def test_rejects_mime_spoofing_animation_and_excessive_pixels(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, output, thumbnail = root / 'source', root / 'out.png', root / 'thumb.png'
            Image.new('RGB', (2, 2)).save(source, 'PNG')
            with self.assertRaisesRegex(ValueError, 'type'):
                normalize(source, output, thumbnail, 'image/jpeg')
            frames = [Image.new('RGB', (2, 2), color) for color in ['red', 'green']]
            for fmt, mime in [('PNG', 'image/png'), ('WEBP', 'image/webp')]:
                frames[0].save(source, fmt, save_all=True, append_images=frames[1:], duration=100, loop=0)
                with self.assertRaisesRegex(ValueError, 'Animated'):
                    normalize(source, output, thumbnail, mime)
            Image.new('RGB', (4001, 4000)).save(source, 'PNG')
            with self.assertRaisesRegex(ValueError, '16 megapixels'):
                normalize(source, output, thumbnail, 'image/png')

    def test_selected_manifest_is_the_complete_matching_universe_and_preserves_crop(self):
        import argparse
        class Encoder:
            def __init__(self, args):
                pass
            def encode(self, images):
                return [[1, 0] if image.getpixel((0, 0))[0] > 200 else [0, 1] for image in images]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            Image.new('RGB', (4, 4), 'red').save(root / 'red.png')
            Image.new('RGB', (4, 4), 'green').save(root / 'green.png')
            manifest = root / 'selected.json'
            manifest.write_text(json.dumps({'references': [{'id': 'only-green', 'category': 'custom', 'path': 'green.png', 'crop': [1, 1, 3, 3]}]}))
            args = argparse.Namespace(manifest=manifest, command='serve', model='fixture', pretrained='fixture', weights=None, device='cpu')
            with patch('image_match.Encoder', Encoder):
                refs, images, hashes, _, metadata = prepare_gallery(args)
            self.assertEqual(metadata['referenceCount'], 1)
            self.assertEqual(images, [])
            self.assertEqual(hashes, [])
            self.assertEqual(refs[0]['crop'], [1, 1, 3, 3])
            result = match_features([1, 0], refs)
            self.assertEqual(result['matchedReference'], 'only-green')
            self.assertEqual(result['similarity'], 0)
            self.assertFalse(result['trigger'])


if __name__ == '__main__':
    unittest.main()
