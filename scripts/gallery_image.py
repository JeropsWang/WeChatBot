"""Decode and normalize a static gallery upload without loading the model."""

import json
import sys
from pathlib import Path
from PIL import Image, ImageOps


def normalize(source, output, thumbnail, mime, crop=None):
    """校验静态 PNG/JPEG/WebP 的实际内容、帧数和像素上限，再生成规范 PNG 与缩略图。
    Image.open 是惰性解码，load 强制在关闭源文件前发现解码错误；exif_transpose 按方向信息旋转后转 RGB。
    完整规范图先保存，crop 只影响缩略预览；thumbnail 原地保持比例缩小，不会放大。此过程不加载模型或联网。
    """
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
