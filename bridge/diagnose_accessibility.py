# 读取与验证 UIA 兼容状态，版本或摘要不匹配时拒绝修改；不自动授权兼容。
"""Read-only UIA/MSAA structure probe. Never reads Name/Value/message content.

Uses standard accessibility query APIs only, without changing SPI flags, registry,
window focus, process lifecycle, or the contents of any conversation.
"""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import winreg
from diagnostics import inventory


def accessibility_settings():
    result = {}
    enabled = wintypes.BOOL()
    ok = ctypes.windll.user32.SystemParametersInfoW(
        0x0046, 0, ctypes.byref(enabled), 0
    )  # SPI_GETSCREENREADER only
    result['screenReaderFlag'] = bool(enabled.value) if ok else None
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Narrator\NoRoam', 0, winreg.KEY_READ
        ) as key:
            result['narratorRunningState'] = winreg.QueryValueEx(key, 'RunningState')[0]
    except FileNotFoundError:
        result['narratorRunningState'] = 'missing'
    except OSError as exc:
        result['narratorRunningState'] = {'error': type(exc).__name__}
    return result


def native_children(hwnd):
    import win32gui

    children = []

    def child(handle, _):
        children.append(
            {
                'hwnd': handle,
                'className': win32gui.GetClassName(handle),
                'visible': bool(win32gui.IsWindowVisible(handle)),
            }
        )
        return True

    win32gui.EnumChildWindows(hwnd, child, None)
    return children


def uia_structure(hwnd):
    from wx4py.core import uiautomation as uia

    root = uia.ControlFromHandle(hwnd)
    rows, stack = [], [(root, 0)]
    while stack and len(rows) < 500:
        node, depth = stack.pop()
        row = {'depth': depth}
        for attr in (
            'ClassName',
            'AutomationId',
            'ControlTypeName',
            'FrameworkId',
            'NativeWindowHandle',
        ):
            try:
                row[attr] = getattr(node, attr)
            except Exception as exc:
                row[attr] = {'error': type(exc).__name__}
        try:
            pattern = node.GetLegacyIAccessiblePattern()
            row['legacyPattern'] = (
                {'role': pattern.Role, 'state': pattern.State, 'childId': pattern.ChildId}
                if pattern
                else None
            )
        except Exception as exc:
            row['legacyPattern'] = {'error': type(exc).__name__}
        rows.append(row)
        if depth < 20:
            try:
                for child in reversed(node.GetChildren()):
                    stack.append((child, depth + 1))
            except Exception as exc:
                row['childrenError'] = type(exc).__name__
    return {'nodeCount': len(rows), 'truncated': bool(stack), 'rawViewNodes': rows}


def getobject_queries(hwnd):
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    user32.SendMessageTimeoutW.argtypes = [
        wintypes.HWND,
        wintypes.UINT,
        wintypes.WPARAM,
        wintypes.LPARAM,
        wintypes.UINT,
        wintypes.UINT,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    user32.SendMessageTimeoutW.restype = ctypes.c_size_t
    result = {}
    try:
        core = ctypes.WinDLL('UIAutomationCore', use_last_error=True)
        core.UiaHasServerSideProvider.argtypes = [wintypes.HWND]
        core.UiaHasServerSideProvider.restype = wintypes.BOOL
        result['hasServerSideUiaProvider'] = bool(core.UiaHasServerSideProvider(hwnd))
    except Exception as exc:
        result['serverSideProviderError'] = type(exc).__name__
    for label, object_id in [('msaaClient', -4), ('uiaRoot', -25)]:
        value = ctypes.c_size_t()
        ctypes.set_last_error(0)
        ok = user32.SendMessageTimeoutW(
            hwnd, 0x003D, 0, object_id, 0x0002, 1200, ctypes.byref(value)
        )
        result[label] = {
            'queryCompleted': bool(ok),
            'providerReturned': bool(value.value),
            'win32Error': ctypes.get_last_error(),
        }
    return result


def msaa_structure(hwnd):
    # Minimal IAccessible definition exposes only structural getters, never names.
    import comtypes
    from comtypes.automation import IDispatch, VARIANT
    from comtypes import COMMETHOD, GUID, HRESULT

    class IAccessible(IDispatch):
        _iid_ = GUID('{618736E0-3C3D-11CF-810C-00AA00389B71}')
        _methods_ = [
            COMMETHOD(
                [],
                HRESULT,
                'get_accParent',
                (['out', 'retval'], ctypes.POINTER(ctypes.POINTER(IDispatch)), 'parent'),
            ),
            COMMETHOD(
                [],
                HRESULT,
                'get_accChildCount',
                (['out', 'retval'], ctypes.POINTER(ctypes.c_long), 'count'),
            ),
        ]

    oleacc = ctypes.OleDLL('oleacc')
    oleacc.AccessibleObjectFromWindow.argtypes = [
        wintypes.HWND,
        wintypes.DWORD,
        ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.POINTER(IAccessible)),
    ]
    oleacc.AccessibleObjectFromWindow.restype = HRESULT
    result = {}
    for label, object_id in [('client', 0xFFFFFFFC), ('window', 0)]:
        try:
            obj = ctypes.POINTER(IAccessible)()
            oleacc.AccessibleObjectFromWindow(
                hwnd, object_id, ctypes.byref(IAccessible._iid_), ctypes.byref(obj)
            )
            if not obj:
                result[label] = {'available': False}
                continue
            result[label] = {'available': True, 'childCount': obj.get_accChildCount()}
            # Child objects may contain private text. Collect counts/types only.
            count = min(result[label]['childCount'], 100)
            if count:
                children, obtained = (VARIANT * count)(), ctypes.c_long()
                oleacc.AccessibleChildren.argtypes = [
                    ctypes.POINTER(IAccessible),
                    ctypes.c_long,
                    ctypes.c_long,
                    ctypes.POINTER(VARIANT),
                    ctypes.POINTER(ctypes.c_long),
                ]
                oleacc.AccessibleChildren.restype = HRESULT
                oleacc.AccessibleChildren(obj, 0, count, children, ctypes.byref(obtained))
                structural = []
                for child in children[: obtained.value]:
                    row = {'variantType': child.vt}
                    if child.vt == 9:
                        try:
                            row['childCount'] = child.value.QueryInterface(
                                IAccessible
                            ).get_accChildCount()
                        except Exception as exc:
                            row['childCountError'] = type(exc).__name__
                    structural.append(row)
                result[label]['childrenStructure'] = structural
        except Exception as exc:
            result[label] = {
                'available': False,
                'error': type(exc).__name__,
                'hresult': getattr(exc, 'hresult', None),
            }
    return result


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    diagnostic = inventory()
    result = {
        'inventory': diagnostic,
        'accessibilitySettingsReadOnly': accessibility_settings(),
        'windows': [],
        'readChatContent': False,
        'changedSystemSettings': False,
        'clickedControls': False,
        'userConfirmedLoggedInMainWindow': True,
    }
    for process in diagnostic['processes']:
        if not process['version'] or not process['version'].startswith('4.'):
            continue
        for window in process['windows']:
            if not window['visible']:
                continue
            hwnd = window['hwnd']
            entry = {
                'hwnd': hwnd,
                'nativeChildren': native_children(hwnd),
                'uiaBefore': uia_structure(hwnd),
                'getObject': getobject_queries(hwnd),
                'msaa': msaa_structure(hwnd),
            }
            for child in entry['nativeChildren']:
                child['getObject'] = getobject_queries(child['hwnd'])
                child['msaa'] = msaa_structure(child['hwnd'])
                child['uiaStructure'] = uia_structure(child['hwnd'])
            entry['uiaAfter'] = uia_structure(hwnd)
            result['windows'].append(entry)
    path = Path(__file__).resolve().parents[1] / 'artifacts' / 'bridge-accessibility-current.json'
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
