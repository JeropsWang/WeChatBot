# 协调头像命中与资料卡候选读取，生产链路也会调用本模块。点击前重新核对消息位置；识别失败保持未知，不提升权限。
"""Validated live-row capture shared by profile lookups and isolated diagnostics.

This must be called on the existing bridge UI thread. It never stores identity,
never accepts caller coordinates. The adapter validates the bound group window.
"""
import ctypes, hashlib, time
from PIL import Image
from identity_experiment import run_identity_probe
from identity_visual import avatar_candidates
from avatar_descriptor import describe_avatar
from visual_messages import visual_kind, matches_visual_marker


class SampleDriver:
    """封装一次资料卡点击前后的 UI 证据，区分已有弹窗与本次新弹窗。
    runtimeId、窗口命中和截图摘要必须在点击前重新核对；关闭只针对本次打开的资料卡，避免误关用户窗口。
    """

    def __init__(
        self,
        adapter,
        name,
        session,
        chat_id=None,
        session_id=None,
        marker='认人重复测试',
        target_runtime=None,
    ):
        self.adapter, self.name, self.session = adapter, name, session
        if not isinstance(marker, str) or not marker.strip() or len(marker) > 16000:
            raise ValueError('消息文字无效')
        self.chat_id = chat_id or name
        self.session_id = session_id or str(session.hwnd)
        self.marker = marker
        self.target_runtime = tuple(target_runtime) if target_runtime else None
        self.current = {}
        self.opened_profile = None

    def has_draft(self):
        from wx4py.features.messaging.listener import WeChatGroupListener

        edit = WeChatGroupListener._find_chat_input(self.session.root)
        if not edit:
            raise RuntimeError('输入框不可用')
        return bool(edit.GetValuePattern().Value or '')

    def _profiles(self):
        import win32gui, win32process
        from wx4py.core import uiautomation as uia

        result = []

        def visit(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return True
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if (
                pid == self.adapter.pid
                and uia.ControlFromHandle(hwnd).ClassName == 'mmui::ProfileUniquePop'
            ):
                result.append(hwnd)
            return True

        win32gui.EnumWindows(visit, None)
        return result

    def has_profile_popup(self):
        return bool(self._profiles())

    def observations(self):
        import win32gui, win32ui

        self.adapter._session(self.name)
        viewport = self.session.msg_list.BoundingRectangle
        l, t, r, b = win32gui.GetWindowRect(self.session.hwnd)
        w, h = r - l, b - t
        if w <= 0 or h <= 0 or w * h > 16_000_000:
            return []
        items = []
        runtime_count = 0
        for item in self.session.msg_list.GetChildren():
            if self.target_runtime:
                try:
                    runtime = tuple(item.GetRuntimeId())
                except Exception:
                    return []
                if runtime == self.target_runtime:
                    runtime_count += 1
                else:
                    continue
            if visual_kind(item.ClassName, item.Name):
                if not matches_visual_marker(item.ClassName, item.Name, self.marker):
                    continue
            elif (
                item.ClassName != 'mmui::ChatTextItemView'
                or (item.Name or '').strip() != self.marker
            ):
                continue
            rect = item.BoundingRectangle
            if (
                rect.left < viewport.left
                or rect.right > viewport.right
                or rect.top < viewport.top
                or rect.bottom > viewport.bottom
            ):
                continue
            items.append((item, rect))
        if not items or len(items) > 20 or self.target_runtime and runtime_count != 1:
            return []
        dc = win32gui.GetWindowDC(self.session.hwnd)
        source = win32ui.CreateDCFromHandle(dc)
        target = source.CreateCompatibleDC()
        bitmap = win32ui.CreateBitmap()
        try:
            bitmap.CreateCompatibleBitmap(source, w, h)
            target.SelectObject(bitmap)
            if not ctypes.windll.user32.PrintWindow(self.session.hwnd, target.GetSafeHdc(), 2):
                return []
            image = Image.frombuffer('RGB', (w, h), bitmap.GetBitmapBits(True), 'raw', 'BGRX', 0, 1)
            rows = []
            current = {}
            for item, rect in items:
                box = (rect.left - l, rect.top - t, rect.right - l, rect.bottom - t)
                if (
                    box[0] < 0
                    or box[1] < 0
                    or box[2] > w
                    or box[3] > h
                    or box[2] <= box[0]
                    or box[3] <= box[1]
                ):
                    return []
                row = image.crop(box)
                candidates = avatar_candidates(row)
                if len(candidates) != 1:
                    return []
                avatar = candidates[0]
                digest = hashlib.sha256(row.crop(avatar).tobytes()).hexdigest()
                runtime = list(item.GetRuntimeId())
                obs = {
                    'chatId': self.chat_id,
                    'sessionId': self.session_id,
                    'runtimeId': runtime,
                    'rect': [rect.left, rect.top, rect.right, rect.bottom],
                    'imageHash': digest,
                    'textHash': hashlib.sha256(self.marker.encode()).hexdigest(),
                    'visible': True,
                    'appearanceDescriptor': describe_avatar(row.crop(avatar)),
                }
                point = (
                    rect.left + (avatar[0] + avatar[2]) // 2,
                    rect.top + (avatar[1] + avatar[3]) // 2,
                )
                rows.append(obs)
                current[tuple(runtime)] = point
            self.current = current
            return rows
        finally:
            try:
                win32gui.DeleteObject(bitmap.GetHandle())
            except Exception:
                pass
            target.DeleteDC()
            source.DeleteDC()
            win32gui.ReleaseDC(self.session.hwnd, dc)

    def target_hit_is_current(self, observation):
        import win32gui
        from wx4py.core import uiautomation as uia
        from identity_focus import ensure_foreground

        self.adapter._session(self.name)
        point = self.current.get(tuple(observation['runtimeId']))
        self.hit_reason = 'point_missing'
        if not point:
            return False
        self.hit_reason = 'foreground_unavailable'
        if not ensure_foreground(self.session.hwnd):
            return False
        hit = win32gui.WindowFromPoint(point)
        self.hit_reason = 'point_covered'
        if win32gui.GetAncestor(hit, 2) != self.session.hwnd:
            return False
        control = uia.ControlFromPoint(*point)
        self.hit_reason = 'row_mismatch'
        for _ in range(7):
            if not control:
                return False
            if list(control.GetRuntimeId()) == observation['runtimeId']:
                self.hit_reason = 'current'
                return True
            control = control.GetParentControl()
        return False

    def click_avatar(self, observation):
        import win32api, win32con

        if not self.target_hit_is_current(observation):
            raise RuntimeError('头像命中不再成立')
        point = self.current[tuple(observation['runtimeId'])]
        win32api.SetCursorPos(point)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)

    def read_new_profile(self):
        from wx4py.core import uiautomation as uia

        deadline = time.monotonic() + 3
        card = None
        last_name = None
        while time.monotonic() < deadline:
            profiles = self._profiles()
            if len(profiles) > 1:
                return None
            if card is not None and profiles != [card]:
                return None
            if len(profiles) == 1:
                card = profiles[0]
                self.opened_profile = card
                try:
                    root = uia.ControlFromHandle(card)
                    names = {
                        (c.Name or '').strip()
                        for c, _ in uia.WalkControl(root, includeTop=True, maxDepth=12)
                        if c.AutomationId == 'right_v_view.nickname_button_view.display_name_text'
                    }
                    names.discard('')
                    if len(names) > 1:
                        return None
                    name = next(iter(names), None)
                    # Qt can expose the popup before rendering the actual name.
                    # Wait for one stable value on the same card instead of closing it.
                    if name and name == last_name:
                        return name
                    last_name = name
                except Exception:
                    last_name = None
            time.sleep(0.1)
        return None

    def close_new_profile(self):
        import win32gui, win32con

        if self.opened_profile and self._profiles() == [self.opened_profile]:
            win32gui.PostMessage(self.opened_profile, win32con.WM_CLOSE, 0, 0)


def run_sample(adapter, name, digest):
    """实验入口只接受仍唯一对应的头像消息证据。
    调用资料卡探测不等于验证成员身份；失败返回 unknown，不能用样本结果自动授予权限。
    """
    session = adapter._session(name)
    driver = SampleDriver(adapter, name, session)
    if driver.has_draft() or driver.has_profile_popup():
        return {'status': 'unknown', 'reason': '存在草稿或资料卡'}
    rows = driver.observations()
    if len(rows) != 2:
        return {'status': 'unknown', 'reason': '两条测试样本未同时可见'}
    matches = [row for row in rows if row['imageHash'] == digest]
    if len(matches) != 1:
        return {'status': 'unknown', 'reason': '目标头像不存在或不唯一'}
    return run_identity_probe(driver, matches[0])
