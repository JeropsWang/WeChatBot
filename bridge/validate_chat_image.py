# 校验图像尺寸、格式和字节，失败即拒绝，不相信上传扩展名。
"""Decode a bounded chat image without writing files or trusting declared dimensions."""
import base64, json, sys, warnings
from io import BytesIO
from PIL import Image

Image.MAX_IMAGE_PIXELS = 16_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
value = json.load(sys.stdin)
raw = base64.b64decode(value['data'], validate=True)
if not 0 < len(raw) <= 5 * 1024 * 1024:
    raise ValueError('Image too large')
with Image.open(BytesIO(raw)) as image:
    if image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'n_frames', 1) != 1:
        raise ValueError('Static image required')
    width, height = image.size
    if width * height > 16_000_000:
        raise ValueError('Too many pixels')
    image.verify()
with Image.open(BytesIO(raw)) as image:
    image.load()
print(
    json.dumps(
        {
            'width': width,
            'height': height,
            'mimeType': {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}[
                image.format
            ],
        }
    )
)
