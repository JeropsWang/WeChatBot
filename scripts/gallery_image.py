"""Decode and normalize a static gallery upload without loading the model."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageOps


def normalize(source, output, thumbnail, mime, crop=None):
    expected = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP'}
    with Image.open(source) as image:
        if mime not in expected or image.format != expected[mime]:
            raise ValueError('Image content does not match its PNG/JPEG/WebP type')
        if getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Animated images are not supported')
        if image.width * image.height > 16_000_000:
            raise ValueError('Image exceeds 16 megapixels')
        image.load()
        image = ImageOps.exif_transpose(image).convert('RGB')
    image.save(output, 'PNG')
    if crop:
        image = image.crop(crop)
    image.thumbnail((320, 320), Image.Resampling.LANCZOS)
    image.save(thumbnail, 'PNG')


if __name__ == '__main__':
    try:
        normalize(*sys.argv[1:5], json.loads(sys.argv[5]) if len(sys.argv) > 5 else None)
        print(json.dumps({'ok': True}))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(2)
