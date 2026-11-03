# 抓取消息自身的图像区域，保留来源与摘要。行复用、外观变化或移动超时应放弃，不能将别人的图片绑定到当前成员。
import os

"""Capture only one positively identified picture child, never a whole chat row."""
import base64, hashlib, ctypes
from io import BytesIO
from collections import Counter
from identity_visual import avatar_candidates
from visual_messages import visual_kind


def self_authored_row(image):
    """Only a unique outer right avatar proves a self row; ignore photo interiors."""
    avatars = avatar_candidates(image)
    return len(avatars) == 1 and avatars[0][0] >= image.width * 0.8 and avatars[0][1] <= 30


def diagnostic_failure(name, row, metadata):
    """Temporary, test-group-only opt-in; never persist other groups' content."""
    from pathlib import Path
    import json, time

    root = Path(__file__).resolve().parents[1] / 'artifacts'
    if (
        not os.environ.get('WECHATBOT_TEST_GROUP') or name != os.environ.get('WECHATBOT_TEST_GROUP')
    ) or not (root / 'chat-image-capture-diagnostics.on').exists():
        return
    try:
        token = (
            str(time.time_ns())
            + '-'
            + hashlib.sha256(str(metadata.get('runtime')).encode()).hexdigest()[:12]
        )
        base = 'chat-image-capture-failure-' + token
        row.save(root / (base + '.png'))
        metadata = {**metadata, 'imageFile': base + '.png'}
        (root / (base + '.json')).write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf8'
        )
        (root / 'chat-image-capture-failure-latest.json').write_text(
            json.dumps({'metadataFile': base + '.json', 'imageFile': base + '.png'}),
            encoding='utf8',
        )
        for old in sorted(root.glob('chat-image-capture-failure-*.json'), key=lambda p: p.name)[
            :-21
        ]:
            if old.name.endswith('latest.json'):
                continue
            old.with_suffix('.png').unlink(missing_ok=True)
            old.unlink(missing_ok=True)
    except Exception:
        pass


def placeholder_pixels(image):
    """Identify a low-fill image placeholder frame, excluding avatar and name."""
    image = image.convert('RGB')
    width, height = image.size
    avatars = avatar_candidates(image)
    if len(avatars) != 1 or avatars[0][0] > width * 0.2:
        return None
    avatar = avatars[0]
    start = avatar[2] + max(8, (avatar[2] - avatar[0]) // 5)
    bg = Counter(image.getdata()).most_common(1)[0][0]
    p = image.load()
    mask = set()
    ystart = avatar[1] + max(25, (avatar[3] - avatar[1]) // 2)
    for y in range(ystart, height):
        for x in range(start, width):
            if max(abs(p[x, y][k] - bg[k]) for k in range(3)) > 6:
                mask.add(y * width + x)
    frames = []
    while mask:
        todo = [mask.pop()]
        n = 0
        x1 = width
        y1 = height
        x2 = y2 = 0
        while todo:
            v = todo.pop()
            y, x = divmod(v, width)
            n += 1
            x1 = min(x1, x)
            x2 = max(x2, x + 1)
            y1 = min(y1, y)
            y2 = max(y2, y + 1)
            for q in (v - 1, v + 1, v - width, v + width):
                if q in mask and abs(q % width - x) <= 1:
                    mask.remove(q)
                    todo.append(q)
        w, h = x2 - x1, y2 - y1
        if (
            w >= 120
            and h >= 120
            and 0.7 < w / h < 1.4
            and n / (w * h) < 0.12
            and x1 > start
            and y1 > ystart
            and x2 < width
            and y2 < height
        ):
            frames.append((x1, y1, x2, y2))
    return frames[0] if len(frames) == 1 else None


def picture_pixels(image):
    """Fallback for Qt row-only UIA: one large connected photo right of its avatar.

    Username glyphs and the independently detected avatar are excluded by geometry;
    sparse drawings, multiple candidates and clipped rows intentionally fail closed.
    """
    image = image.convert('RGB')
    width, height = image.size
    avatars = avatar_candidates(image)
    if len(avatars) != 1:
        return None
    avatar = avatars[0]
    aw, ah = avatar[2] - avatar[0], avatar[3] - avatar[1]
    if avatar[0] > width * 0.2:
        return None
    start = avatar[2] + max(8, aw // 5)
    bg = Counter(image.getdata()).most_common(1)[0][0]
    pixels = image.load()
    mask = set()
    for y in range(height):
        for x in range(start, width):
            if max(abs(pixels[x, y][k] - bg[k]) for k in range(3)) > 18:
                mask.add(y * width + x)
    candidates = []
    while mask:
        seed = mask.pop()
        todo = [seed]
        count = 0
        x1 = width
        y1 = height
        x2 = y2 = 0
        while todo:
            point = todo.pop()
            y, x = divmod(point, width)
            count += 1
            x1 = min(x1, x)
            x2 = max(x2, x + 1)
            y1 = min(y1, y)
            y2 = max(y2, y + 1)
            for nxt in (point - 1, point + 1, point - width, point + width):
                if nxt in mask and abs(nxt % width - x) <= 1:
                    mask.remove(nxt)
                    todo.append(nxt)
        w, h = x2 - x1, y2 - y1
        if (
            w >= max(64, aw)
            and h >= max(64, ah)
            and w * h >= aw * ah * 3
            and count / (w * h) > 0.45
        ):
            if x1 <= start or x2 >= width or y1 <= 0 or y2 >= height:
                return None
            candidates.append((x1, y1, x2, y2))
    return candidates[0] if len(candidates) == 1 else None


def picture_rect(children, row_rect, viewport):
    def inside(r, b):
        return len(r) == 4 and b[0] <= r[0] < r[2] <= b[2] and b[1] <= r[1] < r[3] <= b[3]

    candidates = []
    for child in children:
        rect = child.get('rect', [])
        label = (child.get('id', '') + ' ' + child.get('class', '')).lower()
        if 'avatar' in label or 'head' in label:
            continue
        # A generic ImageControl may be a large avatar. Require picture semantics,
        # never infer the picture region from size alone.
        explicit = child.get('class') in ('mmui::PictureView', 'mmui::ImageBubble')
        named = any(
            word in child.get('id', '').lower()
            for word in ('picture', 'image_content', 'content_image', 'image_bubble')
        )
        if not explicit and not (child.get('type') == 'ImageControl' and named):
            continue
        if (
            inside(rect, row_rect)
            and inside(rect, viewport)
            and (rect[2] - rect[0]) * (rect[3] - rect[1]) >= 4096
            and rect not in candidates
        ):
            candidates.append(rect)
    return candidates[0] if len(candidates) == 1 else None


def capture(adapter, name, runtime, expected_rect):
    """从当前可见消息行安全裁剪图片，返回图片载荷或 unavailable 原因。
    必须排除头像/文字区域，并在截图前后核对消息位置；缩略图证据不能被描述成原始文件或完整动画。
    """
    import win32gui, win32ui
    from PIL import Image
    from wx4py.core import uiautomation as uia

    session = adapter._session(name)
    matches = [
        row
        for row in session.msg_list.GetChildren()
        if list(row.GetRuntimeId()) == runtime and visual_kind(row.ClassName, row.Name)
    ]
    if len(matches) != 1:
        return {'status': 'unavailable', 'reason': '图片气泡不再唯一可见'}
    row = matches[0]
    media_kind = visual_kind(row.ClassName, row.Name)
    r = row.BoundingRectangle
    if [r.left, r.top, r.right, r.bottom] != expected_rect:
        return {'status': 'unavailable', 'reason': '图片气泡已移动'}
    v = session.msg_list.BoundingRectangle
    children = []
    if not (v.left <= r.left < r.right <= v.right and v.top <= r.top < r.bottom <= v.bottom):
        return {'status': 'unavailable', 'reason': '图片行不完整'}
    for child, depth in uia.WalkControl(row, includeTop=False, maxDepth=4):
        b = child.BoundingRectangle
        children.append(
            {
                'class': child.ClassName,
                'type': child.ControlTypeName,
                'id': child.AutomationId or '',
                'rect': [b.left, b.top, b.right, b.bottom],
            }
        )
        if len(children) > 80:
            return {'status': 'unavailable', 'reason': '图片子控件过多'}
    rect = picture_rect(children, expected_rect, [v.left, v.top, v.right, v.bottom])
    l, t, right, bottom = win32gui.GetWindowRect(session.hwnd)
    w, h = right - l, bottom - t
    if w <= 0 or h <= 0 or w * h > 16_000_000:
        return {'status': 'unavailable', 'reason': '窗口尺寸不可用'}
    dc = win32gui.GetWindowDC(session.hwnd)
    source = win32ui.CreateDCFromHandle(dc)
    target = source.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(source, w, h)
        target.SelectObject(bitmap)
        if not ctypes.windll.user32.PrintWindow(session.hwnd, target.GetSafeHdc(), 2):
            return {'status': 'unavailable', 'reason': '图片截图失败'}
        image = Image.frombuffer('RGB', (w, h), bitmap.GetBitmapBits(True), 'raw', 'BGRX', 0, 1)
        if not (
            l <= expected_rect[0] < expected_rect[2] <= right
            and t <= expected_rect[1] < expected_rect[3] <= bottom
        ):
            return {'status': 'unavailable', 'reason': '图片行不完整'}
        row_image = image.crop(
            (expected_rect[0] - l, expected_rect[1] - t, expected_rect[2] - l, expected_rect[3] - t)
        )
        avatars = avatar_candidates(row_image)
        if self_authored_row(row_image):
            after = row.BoundingRectangle
            if (
                list(row.GetRuntimeId()) != runtime
                or [after.left, after.top, after.right, after.bottom] != expected_rect
                or visual_kind(row.ClassName, row.Name) != media_kind
            ):
                return {'status': 'unavailable', 'reason': '截图期间图片气泡变化'}
            return {
                'status': 'unavailable',
                'isSelf': True,
                'reason': '右侧本人头像已确认，跳过自发图片',
            }
        avatar_hash = (
            hashlib.sha256(row_image.crop(avatars[0]).tobytes()).hexdigest()
            if len(avatars) == 1
            else None
        )
        if rect is None:
            local = picture_pixels(row_image)
            if local:
                rect = [
                    expected_rect[0] + local[0],
                    expected_rect[1] + local[1],
                    expected_rect[0] + local[2],
                    expected_rect[1] + local[3],
                ]
            else:
                diagnostic_failure(
                    name,
                    row_image,
                    {
                        'row': expected_rect,
                        'viewport': [v.left, v.top, v.right, v.bottom],
                        'window': [l, t, right, bottom],
                        'foreground': win32gui.GetForegroundWindow() == session.hwnd,
                        'runtime': runtime,
                        'avatars': avatar_candidates(row_image),
                        'pixelBounds': None,
                    },
                )
                return {'status': 'unavailable', 'reason': '无法安全区分图片区域与头像/文字'}
        if rect[0] < l or rect[1] < t or rect[2] > right or rect[3] > bottom:
            return {'status': 'unavailable', 'reason': '图片超出窗口'}
        image = image.crop((rect[0] - l, rect[1] - t, rect[2] - l, rect[3] - t))
        if max(channel[1] - channel[0] for channel in image.getextrema()) < 2:
            return {'status': 'unavailable', 'reason': '截图为空或纯色，需重新发送'}
        after = row.BoundingRectangle
        if (
            list(row.GetRuntimeId()) != runtime
            or [after.left, after.top, after.right, after.bottom] != expected_rect
            or visual_kind(row.ClassName, row.Name) != media_kind
        ):
            return {'status': 'unavailable', 'reason': '截图期间图片气泡变化'}
        output = BytesIO()
        image.save(output, 'PNG')
        raw = output.getvalue()
        if len(raw) > 5 * 1024 * 1024:
            return {'status': 'unavailable', 'reason': '截图超过5MiB'}
        return {
            'status': 'ready',
            'mimeType': 'image/png',
            'width': image.width,
            'height': image.height,
            'sha256': hashlib.sha256(raw).hexdigest(),
            'quality': 'thumbnail',
            'data': base64.b64encode(raw).decode(),
            'avatarHash': avatar_hash,
        }
    finally:
        win32gui.DeleteObject(bitmap.GetHandle())
        target.DeleteDC()
        source.DeleteDC()
        win32gui.ReleaseDC(session.hwnd, dc)
