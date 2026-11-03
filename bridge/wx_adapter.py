# 适配现有微信窗口和 UIA 控件，不登录、不重启客户端。目标必须唯一匹配群聊；失焦、草稿、身份歧义或控件变化时拒绝猜测。
import os

"""Pinned wx4py 0.2.1 adapter for existing, logged-in WeChat 4.x windows.

Never calls WeChatClient.connect / WeChatWindow.connect / refresh. Those helpers
change accessibility settings, restart WeChat and may click the login screen.
"""
from importlib.metadata import version
from types import SimpleNamespace
import threading
import time
from diagnostics import inventory
from engine import binding_key
from store import reconcile


class SafeAttachError(RuntimeError):
    pass


def exact_group_result(items, name):
    """从搜索分区中选择唯一且名称完整一致的候选控件。
    联系人、截断结果或同名多候选一律拒绝；搜索命中还不是群身份证明，调用方仍须核对群信息。
    """
    section, matches, truncated = None, [], False
    for control in items:
        cls, auto_id, label = (
            control.ClassName or '',
            control.AutomationId or '',
            control.Name or '',
        )
        if cls == 'mmui::XTableCell' and not auto_id:
            if label in {'联系人', '群聊', '最常使用', '功能', '聊天记录', '搜索网络结果'}:
                section = label
            elif section in {'群聊', '最常使用'} and ('查看全部' in label or '更多' in label):
                truncated = True
        elif (
            'SearchContentCellView' in cls
            and auto_id.startswith('search_item_')
            and label.strip() == name
        ):
            matches.append((section, control))
    if truncated or len(matches) != 1 or matches[0][0] not in {'群聊', '最常使用'}:
        raise SafeAttachError(f'未找到唯一完整匹配的群聊「{name}」（重名或结果不完整时禁止猜测）')
    return matches[0][1]


def nickname_from_label(manager, label):
    values = {
        (getattr(c, 'Name', '') or '').strip()
        for c in manager._walk_controls(label, max_depth=5)
        if getattr(c, 'ControlTypeName', '') == 'TextControl'
    }
    values.discard('')
    values.discard('我在本群的昵称')
    return next(iter(values)) if len(values) == 1 else None


class ExistingWindow:
    def __init__(self, hwnd):
        from wx4py.core.uia_wrapper import UIAWrapper

        self.hwnd = hwnd
        self.uia = UIAWrapper(hwnd)

    def activate(self):
        import win32gui
        from wx4py.core.win32 import bring_window_to_front

        if not win32gui.IsWindow(self.hwnd) or not win32gui.IsWindowVisible(self.hwnd):
            raise SafeAttachError('现有微信窗口不可见；请在桌面中手动打开')
        return bring_window_to_front(self.hwnd)

    def refresh(self):
        raise SafeAttachError('已禁用自动修复、重连和重启微信')


class WxAdapter:
    """现有已登录微信窗口的 UIA 适配层，锁定 wx4py 0.2.1 行为。
    构造时记录线程 ID，所有读写必须在该线程；不调用可能改系统设置或重启微信的自动 connect/refresh。
    """

    def __init__(self):
        self.thread_id = threading.get_ident()
        self.window = None
        self.sessions = {}
        self.diagnostics = {}
        self.detail = '尚未检查微信窗口'
        self.pid = None
        self.group_nicknames = {}
        self.unread_navigation = {}

    def _thread(self):
        """检查调用线程，防止把 COM/UIA 控件跨线程传递；网络任务必须通过 UI 命令队列串行处理。"""
        if threading.get_ident() != self.thread_id:
            raise RuntimeError('所有UIA操作必须在唯一COM线程执行')

    def attach(self):
        """仅从诊断结果中附着现有且可访问的主窗口，不触发登录。
        先验证适配库版本与窗口结构，不满足条件抛 SafeAttachError，由上层报告不支持而非自动修复微信。
        """
        self._thread()
        if version('wx4py') != '0.2.1':
            raise SafeAttachError('适配器仅支持已锁定的wx4py 0.2.1')
        self.diagnostics = inventory()
        self.detail = self.diagnostics['detail']
        if not self.diagnostics['supported']:
            self.window = None
            raise SafeAttachError(self.detail)
        for process in self.diagnostics['processes']:
            for window in process['windows']:
                if (
                    window.get('uiaClassName', window['className']) == 'mmui::MainWindow'
                    and window['visible']
                    and window.get('uiaNodeCount', 0) >= 5
                ):
                    self.window = ExistingWindow(window['hwnd'])
                    self.pid = process['pid']
        return self.status()

    def status(self):
        self._thread()
        import win32gui
        from wx4py.core import uiautomation as uia

        try:
            # Re-resolve the HWND: an old provider can retain its mmui class
            # after the accessibility gate is removed, despite dead children.
            ok = bool(
                self.window
                and win32gui.IsWindow(self.window.hwnd)
                and uia.ControlFromHandle(self.window.hwnd).ClassName == 'mmui::MainWindow'
            )
            if self.window and not ok:
                self.detail = '微信无障碍控件已失效；请停止桥接后按需勾选临时兼容模式重新启动'
        except Exception:
            ok = False
        return {
            'connected': ok,
            'capabilities': {
                'receive': ok,
                'send': ok,
                'listGroups': ok,
                'senderIdentity': False,
                'durableReplay': True,
            },
            'detail': self.detail,
            'diagnostics': self.diagnostics,
        }

    def _group_windows(self, name=None):
        import win32gui
        import win32process

        result = []

        def callback(hwnd, _):
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if pid == self.pid and win32gui.IsWindowVisible(hwnd) and hwnd != self.window.hwnd:
                # Window titles identify chats; never read their message controls here.
                title = win32gui.GetWindowText(hwnd)
                if name is None or title == name:
                    result.append((hwnd, title))
            return True

        win32gui.EnumWindows(callback, None)
        return result

    def _open_session_window(self, item):
        # Newer Weixin exposes an explicit action; double-click may do nothing.
        item.RightClick(simulateMove=False)
        menu = self.window.uia.root.WindowControl(ClassName='mmui::XMenu')
        if not menu.Exists(maxSearchSeconds=0.5):
            self.window.uia.root.SendKeys('{Esc}')
            raise SafeAttachError('未找到会话菜单，无法打开独立群窗口')
        action = menu.MenuItemControl(Name='独立窗口显示')
        if not action.Exists(maxSearchSeconds=0.5):
            self.window.uia.root.SendKeys('{Esc}')
            raise SafeAttachError('会话菜单未提供独立窗口显示，禁止猜测菜单位置')
        action.Click(simulateMove=False)

    def _open_exact_group(self, name):
        """Read group result names only. No contact results or history snippets."""
        from wx4py.features.chat import ChatWindow

        self.window.activate()
        chat = ChatWindow(self.window)
        if not chat._input_search(name):
            raise SafeAttachError('无法安全使用微信搜索框')
        try:
            popup = chat._get_search_popup()
            if not popup:
                raise SafeAttachError('未找到群搜索面板')
            result_list = popup.ListControl(AutomationId='search_list')
            if not result_list.Exists(maxSearchSeconds=0.5):
                raise SafeAttachError('搜索结果结构不受支持')
            exact_group_result(result_list.GetChildren(), name).Click(simulateMove=False)
        finally:
            chat._clear_search()
        time.sleep(0.6)
        # Frequent results can include contacts. Prove the selected target is a
        # group before reading messages or accepting its independent window.
        from wx4py.features.groups import GroupManager

        manager = GroupManager(self.window)
        if not manager._open_group_detail() or not manager._get_group_detail_view():
            self.window.uia.root.SendKeys('{Esc}')
            raise SafeAttachError('选中目标未通过群聊详情校验，禁止读取或发送')
        panel = manager._get_group_detail_view()
        nickname = None
        for control in manager._walk_controls(panel, max_depth=20):
            if control.ClassName == 'mmui::XPreviewInputField' and control.Name == '我在本群的昵称':
                nickname = nickname_from_label(manager, control)
                if nickname:
                    break
        if not nickname:
            panel.SetFocus()
            focused = manager._tab_to_control('我在本群的昵称')
            if focused:
                nickname = nickname_from_label(manager, focused)
        self.group_nicknames[name] = nickname
        self.window.uia.root.SendKeys('{Esc}')
        # Only the selected session can be read. Other session labels can contain previews.
        from wx4py.features.messaging.listener import _find_session_list

        sessions = _find_session_list(self.window.uia.root)
        if not sessions:
            raise SafeAttachError('未找到会话列表，无法绑定独立群窗口')
        selected = []
        for item in sessions.GetChildren():
            try:
                if item.GetSelectionItemPattern().IsSelected:
                    selected.append(item)
            except Exception:
                try:
                    if item.IsSelected:
                        selected.append(item)
                except Exception:
                    pass
        if len(selected) != 1:
            raise SafeAttachError('无法确认唯一选中的授权群聊')
        selected_name = (selected[0].Name or '').split('\n', 1)[0].strip()
        if selected_name != name:
            raise SafeAttachError('选中会话名称与白名单群不符')
        self._open_session_window(selected[0])
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            windows = self._group_windows(name)
            if len(windows) > 1:
                raise SafeAttachError('发现多个同名窗口，拒绝绑定')
            if len(windows) == 1:
                return windows[0][0]
            time.sleep(0.2)
        raise SafeAttachError('授权群独立窗口未出现')

    def bind(self, name):
        """为一个明确授权的准确群名绑定聊天窗口，并核对实际打开的会话。
        群搜索可能混入联系人或重名结果；只有完整且唯一匹配才接受，不把搜索文本本身当目标身份证据。
        """
        self._thread()
        if not self.status()['connected']:
            raise SafeAttachError(self.detail)
        if name in self.sessions:
            try:
                self._session(name)
                return {'nickname': self.sessions[name].nickname}
            except SafeAttachError:
                self.sessions.pop(name)
        if len(self._group_windows(name)) > 1:
            raise SafeAttachError('发现多个同名窗口，拒绝猜测目标')
        hwnd = self._open_exact_group(name)
        window = ExistingWindow(hwnd)
        from wx4py.features.groups import GroupManager
        from wx4py.features.messaging.listener import _find_message_list

        msg_list = _find_message_list(window.uia.root)
        if not msg_list:
            raise SafeAttachError('群窗口未暴露受支持的消息列表')
        nickname = self.group_nicknames.get(name)
        manager = GroupManager(window)
        # Open only this validated group's information panel. Read the existing
        # nickname label; never enter inline edit mode or press its confirm key.
        try:
            if not nickname and manager._open_group_detail():
                panel = manager._get_group_detail_view()
                if panel:
                    for control in manager._walk_controls(panel, max_depth=8):
                        if '我在本群的昵称' in (control.Name or ''):
                            nickname = manager._extract_group_nickname_from_control(control)
                            if nickname:
                                break
                window.uia.root.SendKeys('{Esc}')
        except Exception:
            nickname = None
        self.sessions[name] = SimpleNamespace(
            hwnd=hwnd, root=window.uia.root, msg_list=msg_list, nickname=nickname
        )
        self.detail = '已绑定现有微信4.x；发送者身份不可用' + (
            '；@检测可用' if nickname else '；未读取到群昵称，@检测降级'
        )
        return {'nickname': nickname}

    def unbind_except(self, names):
        self._thread()
        self.sessions = {k: v for k, v in self.sessions.items() if k in names}

    def _session(self, name):
        self._thread()
        import win32gui
        import win32process

        if not self.status()['connected']:
            raise SafeAttachError(self.detail)
        session = self.sessions.get(name)
        if not session or not win32gui.IsWindow(session.hwnd):
            raise SafeAttachError('授权群窗口已关闭')
        _, pid = win32process.GetWindowThreadProcessId(session.hwnd)
        if (
            pid != self.pid
            or win32gui.GetWindowText(session.hwnd) != name
            or len(self._group_windows(name)) != 1
        ):
            raise SafeAttachError('群窗口身份或唯一性校验失败')
        return session

    def read(self, name):
        from wx4py.features.messaging.listener import _read_visible_items
        from visual_messages import visual_kind, visual_marker

        session = self._session(name)
        rows = []
        for item in _read_visible_items(session.msg_list):
            try:
                rect = item.control.BoundingRectangle
                bounds = [rect.left, rect.top, rect.right, rect.bottom]
            except Exception:
                bounds = None
            rows.append(
                {
                    'kind': item.kind,
                    'name': item.name,
                    'class': item.class_name,
                    '_runtimeId': list(item.runtime_id),
                    '_rect': bounds,
                }
            )
        # Keep image rows even when their UIA Name is empty. Merge by live position.
        for control in session.msg_list.GetChildren():
            media_kind = visual_kind(control.ClassName, control.Name)
            if media_kind:
                runtime = list(control.GetRuntimeId())
                rect = control.BoundingRectangle
                # The dependency reports native animations as ordinary text. Replace,
                # rather than append, the same runtime row before quote handling.
                rows = [row for row in rows if row.get('_runtimeId') != runtime]
                rows.append(
                    {
                        'kind': 'image',
                        'name': visual_marker(media_kind),
                        'class': control.ClassName,
                        '_runtimeId': runtime,
                        '_rect': [rect.left, rect.top, rect.right, rect.bottom],
                    }
                )
                continue
            if control.ClassName == 'mmui::ChatBubbleReferItemView':
                runtime = list(control.GetRuntimeId())
                if any(row.get('_runtimeId') == runtime for row in rows):
                    for row in rows:
                        if row.get('_runtimeId') == runtime:
                            row['unresolvedQuote'] = True
                    continue
                text = (control.Name or '').strip()
                if not text:
                    from wx4py.core import uiautomation as uia

                    parts = []
                    for child, depth in uia.WalkControl(control, includeTop=False, maxDepth=5):
                        if child.ControlTypeName == 'TextControl' and child.Name:
                            parts.append(child.Name)
                        if len(parts) >= 80:
                            break
                    text = '\n'.join(parts).strip()
                if text:
                    rect = control.BoundingRectangle
                    rows.append(
                        {
                            'kind': 'message',
                            'name': text[:16000],
                            'class': control.ClassName,
                            'unresolvedQuote': True,
                            '_runtimeId': runtime,
                            '_rect': [rect.left, rect.top, rect.right, rect.bottom],
                        }
                    )
                continue
        rows.sort(key=lambda row: (row.get('_rect') or [0, 0])[1])
        return rows

    def capture_image(self, name, runtime, rect):
        """按当前消息的 runtimeId/几何信息捕获图片；窗口已经变化时不得用旧位置猜测。
        返回的是当前可见图片证据，不能宣称获得原文件或完整动画。
        """
        self._thread()
        from chat_image_capture import capture

        return capture(self, name, runtime, rect)

    def prepare_image_capture(self, name):
        """Activate only for a newly observed image; caller rereads after Qt paints."""
        import win32gui, win32con
        from identity_focus import ensure_foreground
        from identity_sample_driver import SampleDriver

        session = self._session(name)
        minimized = win32gui.IsIconic(session.hwnd)
        if not minimized and win32gui.GetForegroundWindow() == session.hwnd:
            return False
        driver = SampleDriver(self, name, session)
        if driver.has_draft() or driver.has_profile_popup():
            return False
        if minimized:
            win32gui.ShowWindow(session.hwnd, win32con.SW_RESTORE)
            deadline = time.monotonic() + 0.6
            while win32gui.IsIconic(session.hwnd) and time.monotonic() < deadline:
                time.sleep(0.05)
            if win32gui.IsIconic(session.hwnd):
                raise SafeAttachError('图片所在群窗口仍最小化')
        if not ensure_foreground(session.hwnd):
            return minimized
        # Qt can expose final rectangles before its image surface is repainted.
        time.sleep(0.2)
        return True

    def prepare_listener_view(self, name):
        """Navigate one proven unread bar only; leave drafts and profile popups alone."""
        import re
        import win32gui
        from wx4py.core import uiautomation as uia
        from identity_sample_driver import SampleDriver
        from identity_focus import ensure_foreground

        session = self._session(name)
        matches = []
        for control, depth in uia.WalkControl(session.root, includeTop=True, maxDepth=10):
            if (
                control.ClassName == 'mmui::UnreadBarView'
                and control.ControlTypeName == 'ButtonControl'
                and re.fullmatch(r'\d+条新消息', control.Name or '')
            ):
                matches.append(control)
            if len(matches) > 1:
                return False
        if len(matches) != 1:
            return False
        stamp = (session.hwnd, tuple(matches[0].GetRuntimeId()), matches[0].Name)
        previous = self.unread_navigation.get(name)
        if previous and (previous[0] == stamp or time.monotonic() - previous[1] < 2):
            return False
        driver = SampleDriver(self, name, session)
        if driver.has_draft() or driver.has_profile_popup():
            return False
        if win32gui.IsIconic(session.hwnd):
            return self.prepare_image_capture(name)
        if not ensure_foreground(session.hwnd):
            return False
        if driver.has_draft() or driver.has_profile_popup():
            return False
        matches[0].Click(simulateMove=False)
        self.unread_navigation[name] = (stamp, time.monotonic())
        self._session(name)
        return True

    def list_chats(self):
        self._thread()
        # Bound groups are proven to be groups. Arbitrary window/session names
        # cannot safely distinguish a contact from a group and are not advertised.
        return [{'name': name, 'bindingKey': binding_key(name)} for name in self.sessions]

    def identity_sample(self, name, digest):
        self._thread()
        from identity_sample_driver import run_sample

        return run_sample(self, name, digest)

    def identity_observations(self, name, chat_id, session_id, marker):
        self._thread()
        from identity_sample_driver import SampleDriver

        if (
            not os.environ.get('WECHATBOT_TEST_GROUP')
            or name != os.environ.get('WECHATBOT_TEST_GROUP')
        ) or marker != '认人实时测试':
            return []
        return SampleDriver(
            self, name, self._session(name), chat_id, session_id, marker
        ).observations()

    def identity_name(self, name, chat_id, session_id, observation):
        self._thread()
        if not os.environ.get('WECHATBOT_TEST_GROUP') or name != os.environ.get(
            'WECHATBOT_TEST_GROUP'
        ):
            return {'status': 'unknown', 'reason': '不属于测试群'}
        from identity_sample_driver import SampleDriver
        from identity_experiment import run_identity_probe

        driver = SampleDriver(self, name, self._session(name), chat_id, session_id, '认人实时测试')
        return run_identity_probe(driver, observation, name_probe=True)

    def identity_message_observation(self, name, chat_id, session_id, text, runtime):
        self._thread()
        from identity_sample_driver import SampleDriver

        driver = SampleDriver(
            self, name, self._session(name), chat_id, session_id, text, target_runtime=runtime
        )
        rows = driver.observations()
        return rows[0] if len(rows) == 1 else None

    def identity_message(self, name, chat_id, session_id, text, runtime, rect, expected=None):
        """针对一条仍在当前窗口中的消息进行资料卡识别。
        必须保留草稿、命中位置与控件稳定性检查；读到名称也只是候选，不据此授予管理权限。
        """
        self._thread()
        from identity_sample_driver import SampleDriver
        from identity_experiment import run_identity_probe

        driver = SampleDriver(
            self, name, self._session(name), chat_id, session_id, text, target_runtime=runtime
        )
        rows = driver.observations()
        if len(rows) != 1 or rows[0]['rect'] != rect:
            return {'status': 'unknown', 'reason': '消息位置已变化'}
        from identity_preflight import validate_observation

        if expected is None or validate_observation(expected, rows[0])['status'] != 'current':
            return {
                'status': 'unknown',
                'reason': '目标证据已变化',
                'reasonCode': 'target_changed',
                'clicked': False,
            }
        result = run_identity_probe(driver, rows[0], name_probe=True, production=True)
        if result.get('status') == 'candidate':
            result['appearanceHash'] = rows[0]['imageHash']
            if rows[0].get('appearanceDescriptor'):
                result['appearanceDescriptor'] = rows[0]['appearanceDescriptor']
        return result

    def send_image(self, name, data):
        """Single PNG paste; require the observed image marker before one Enter."""
        from io import BytesIO
        from PIL import Image
        from wx4py.features.messaging.listener import WeChatGroupListener
        from wx4py.features.chat import ChatWindow
        from wx4py.core import uiautomation as uia
        import win32gui, win32clipboard, win32con

        image = Image.open(BytesIO(data))
        image.load()
        if image.format != 'PNG' or image.width * image.height > 16_000_000:
            return {'status': 'not_sent', 'detail': '图片格式或尺寸不受支持'}
        session = self._session(name)
        edit = WeChatGroupListener._find_chat_input(session.root)
        if not edit:
            return {'status': 'not_sent', 'detail': '授权群输入框不可用'}
        try:
            draft = edit.GetValuePattern().Value or ''
        except Exception:
            return {'status': 'not_sent', 'detail': '无法核实微信草稿'}
        if draft:
            return {'status': 'not_sent', 'detail': '输入框已有文字或图片草稿，请先处理'}

        def image_ids():
            return {
                tuple(x.GetRuntimeId())
                for x in session.msg_list.GetChildren()
                if x.ClassName == 'mmui::ChatImageItemView'
            }

        before = image_ids()
        ExistingWindow(session.hwnd).activate()
        edit.SetFocus()
        focused = uia.GetFocusedControl()
        if (
            win32gui.GetForegroundWindow() != session.hwnd
            or not focused
            or tuple(focused.GetRuntimeId()) != tuple(edit.GetRuntimeId())
        ):
            return {'status': 'not_sent', 'detail': '无法确认目标群输入焦点'}
        output = BytesIO()
        image.convert('RGB').save(output, 'BMP')
        dib = output.getvalue()[14:]
        try:
            win32clipboard.OpenClipboard()
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32con.CF_DIB, dib)
        finally:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass
        ChatWindow._send_ctrl_hotkey_static(0x56)
        time.sleep(0.5)
        if (
            win32gui.GetForegroundWindow() != session.hwnd
            or edit.GetValuePattern().Value != '\ufffc'
        ):
            return {
                'status': 'unknown',
                'detail': '粘贴后未能唯一核实图片草稿，请检查群聊及草稿，禁止自动重发',
            }
        edit.SendKeys('{Enter}')
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            time.sleep(0.2)
            new = image_ids() - before
            if len(new) == 1 and not (edit.GetValuePattern().Value or ''):
                return {
                    'status': 'sent',
                    'detail': '已观察到新增图片气泡和输入框清空（本机发送确认）',
                }
        return {'status': 'unknown', 'detail': '已按发送键但未唯一确认图片气泡，禁止自动重发'}

    def send(self, name, text):
        """向已绑定且复查后的目标会话发送文字；发送动作之后还要读取窗口核对回显。
        异常不等于未发送，调用方必须结合操作阶段把不确定结果写入账本而非直接重试。
        """
        from wx4py.features.messaging.listener import WeChatGroupListener
        import win32gui

        session = self._session(name)
        edit = WeChatGroupListener._find_chat_input(session.root)
        if not edit:
            return {'status': 'not_sent', 'detail': '授权群输入框不可用'}
        try:
            draft = (edit.GetValuePattern().Value or '').strip()
        except Exception:
            return {'status': 'not_sent', 'detail': '无法核实输入框草稿；为保护现有输入未发送'}
        if draft:
            return {'status': 'not_sent', 'detail': '群输入框已有草稿，请先在微信中处理'}
        before = self.read(name)
        ExistingWindow(session.hwnd).activate()
        edit.SetFocus()
        from wx4py.core import uiautomation as uia

        focused = uia.GetFocusedControl()
        if not focused or tuple(focused.GetRuntimeId()) != tuple(edit.GetRuntimeId()):
            return {'status': 'not_sent', 'detail': '无法确认焦点位于绑定群输入框'}
        # Assign directly and verify the exact value before the single send key.
        try:
            edit.GetValuePattern().SetValue(text)
        except Exception:
            return {
                'status': 'not_sent',
                'detail': '无法直接写入微信输入框，未按发送键；请检查微信草稿',
            }
        time.sleep(0.2)
        if win32gui.GetForegroundWindow() != session.hwnd or edit.GetValuePattern().Value != text:
            return {
                'status': 'not_sent',
                'detail': '输入或窗口焦点核对失败，未按发送键；请检查微信草稿',
            }
        edit.SendKeys('{Enter}')
        deadline = time.monotonic() + 5
        current = before
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = self.read(name)
            # Runtime IDs are transient and must not participate in message alignment.
            strip = lambda rows: [
                {k: v for k, v in row.items() if not k.startswith('_')} for row in rows
            ]
            added, gap = reconcile(strip(before), strip(current))
            matches = [
                i for i, row in enumerate(added) if row['kind'] == 'message' and row['name'] == text
            ]
            if not gap and len(matches) == 1 and not (edit.GetValuePattern().Value or '').strip():
                # A matching new bubble and cleared input confirm local UI acceptance,
                # not remote delivery. Exact positional occurrence only; no content TTL.
                index = len(current) - len(added) + matches[0]
                return {
                    'status': 'sent',
                    'detail': '已观察到绑定群新增消息气泡及输入框清空（本地发送确认）',
                    'snapshot': current,
                    'selfIndices': [index],
                }
        return {
            'status': 'unknown',
            'detail': '已执行一次发送键，但未获得唯一新增气泡确认；禁止自动重发',
            'snapshot': current,
        }
