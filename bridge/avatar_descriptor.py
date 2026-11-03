# 从头像图像生成可比较外观描述；相似外观只是证据，不构成唯一身份。
"""Render-tolerant collision evidence; never a member ID or permission credential."""
from PIL import Image, ImageStat


def describe_avatar(image):
    image = image.convert('RGB')
    w, h = image.size
    inset = max(1, min(w, h) // 12)
    image = image.crop((inset, inset, w - inset, h - inset))
    bits = 0
    horizontal = image.convert('L').resize((9, 8), Image.Resampling.BILINEAR)
    vertical = image.convert('L').resize((8, 9), Image.Resampling.BILINEAR)
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | int(horizontal.getpixel((x, y)) > horizontal.getpixel((x + 1, y)))
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | int(vertical.getpixel((x, y)) > vertical.getpixel((x, y + 1)))
    colors = []
    small = image.resize((16, 16), Image.Resampling.BILINEAR)
    for y in (0, 8):
        for x in (0, 8):
            colors.extend(round(v) for v in ImageStat.Stat(small.crop((x, y, x + 8, y + 8))).mean)
    return {'version': 1, 'hash': f'{bits:032x}', 'colors': colors}
