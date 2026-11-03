# 只读采集进程、窗口与 UIA 可用性，不读取聊天正文或输出密钥；诊断结果不能替代真实收发验收。
"""Read-only desktop inventory. Never activates a window or reads chat text."""
from datetime import datetime, timezone
from importlib.metadata import version
import os
from pathlib import Path

os.environ.setdefault('WECHAT_LOG_LEVEL', 'ERROR')
os.environ.setdefault('WECHAT_LOG_FILE', str(Path(__file__).resolve().parent / 'state' / 'wx4py.log'))


def process_path(pid):
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ''
    try:
        size = wintypes.DWORD(32768)
        buf = ctypes.create_unicode_buffer(size.value)
        return buf.value if kernel.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)) else ''
    finally:
        kernel.CloseHandle(handle)


def inventory():
    import win32api
    import win32gui
    import win32process
    from wx4py.core import uiautomation as uia
    from wx4py.core.window import _count_uia_descendants

    processes = {}
    for pid in win32process.EnumProcesses():
        try:
            path = process_path(pid)
            if os.path.basename(path).lower() not in {'wechat.exe', 'weixin.exe'}:
                continue
            try:
                info = win32api.GetFileVersionInfo(path, '\\')
                a, b = info['FileVersionMS'], info['FileVersionLS']
                file_version = f'{a >> 16}.{a & 65535}.{b >> 16}.{b & 65535}'
            except Exception:
                file_version = None
            processes[pid] = {'pid': pid, 'executable': path, 'version': file_version, 'windows': []}
        except Exception:
            continue

    def window(hwnd, _):
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            if pid not in processes:
                return True
            cls = win32gui.GetClassName(hwnd)
            entry = {'hwnd': hwnd, 'className': cls, 'visible': bool(win32gui.IsWindowVisible(hwnd))}
            # Root/window class and node counts only: no Name, Value, or message text.
            if cls in {'mmui::MainWindow', 'WeChatMainWndForPC'} or entry['visible']:
                try:
                    root = uia.ControlFromHandle(hwnd)
                    entry['uiaClassName'] = root.ClassName
                    entry['uiaNodeCount'] = _count_uia_descendants(root, max_depth=5, limit=100)
                except Exception as exc:
                    entry['uiaError'] = type(exc).__name__
            processes[pid]['windows'].append(entry)
        except Exception:
            pass
        return True

    win32gui.EnumWindows(window, None)
    compatible = [(p, w) for p in processes.values() for w in p['windows']
                  if w.get('uiaClassName', w['className']) == 'mmui::MainWindow' and w['visible'] and w.get('uiaNodeCount', 0) >= 5]
    return {'observedAt': datetime.now(timezone.utc).isoformat(), 'wx4py': version('wx4py'),
            'processes': list(processes.values()), 'safeAttachCandidates': len(compatible),
            'supported': len(compatible) == 1,
            'detail': ('现有微信4.x主窗口可安全绑定' if len(compatible) == 1 else
                       '未找到唯一且UIA节点可用的微信4.x主窗口；未修改注册表、辅助功能标志或重启微信'),
            'readChatContent': False, 'changedSystemSettings': False}
