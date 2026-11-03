# 校验目标窗口和头像命中；不得为采集身份覆盖用户现有输入草稿。
"""Bounded foreground activation for the already validated test-group window."""
import time


class WindowsFocus:
    def is_visible(self, hwnd):
        import win32gui

        return win32gui.IsWindow(hwnd) and win32gui.IsWindowVisible(hwnd)

    def foreground(self):
        import win32gui

        return win32gui.GetForegroundWindow()

    def current_thread(self):
        import win32api

        return win32api.GetCurrentThreadId()

    def window_thread(self, hwnd):
        import win32process

        return win32process.GetWindowThreadProcessId(hwnd)[0] if hwnd else 0

    def attach(self, current, foreground, enabled):
        import win32process

        win32process.AttachThreadInput(current, foreground, enabled)

    def activate(self, hwnd):
        import win32gui, win32con

        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)


def ensure_foreground(hwnd, api=None, clock=time.monotonic, sleep=time.sleep):
    """尝试将现有目标窗口置前并复核前台 HWND，而非仅相信激活调用返回值。
    AttachThreadInput 临时连接线程输入队列，必须在 finally 解除；获取前台失败时不继续点击。
    """
    api = api or WindowsFocus()
    attached = False
    current = foreground_thread = None
    try:
        if not api.is_visible(hwnd):
            return False
        if api.foreground() == hwnd:
            return True
        try:
            api.activate(hwnd)
        except Exception:
            pass
        if api.foreground() == hwnd:
            return True
        current = api.current_thread()
        foreground_thread = api.window_thread(api.foreground())
        if foreground_thread and foreground_thread != current:
            api.attach(current, foreground_thread, True)
            attached = True
        api.activate(hwnd)
        deadline = clock() + 0.6
        while api.foreground() != hwnd and clock() < deadline:
            sleep(0.02)
        return api.foreground() == hwnd
    except Exception:
        return False
    finally:
        if attached:
            try:
                api.attach(current, foreground_thread, False)
            except Exception:
                pass
