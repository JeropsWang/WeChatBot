"""选择唯一可见微信主进程与它实际加载的模块；不假定用户安装目录。"""
from pathlib import PureWindowsPath


def select_visible_client(processes):
    candidates = [p for p in processes if PureWindowsPath(p.get('executable', '')).name.casefold() in {'weixin.exe', 'wechat.exe'}
                  and any(w.get('visible') and w.get('className') == 'mmui::MainWindow' for w in p.get('windows', []))]
    if len(candidates) != 1:
        raise RuntimeError('Expected exactly one visible WeChat 4.x main process')
    return candidates[0]


def select_weixin_module(paths):
    candidates = [p for p in paths if PureWindowsPath(p).name.casefold() == 'weixin.dll']
    if len(candidates) != 1:
        raise RuntimeError('Expected exactly one loaded Weixin.dll module')
    return candidates[0]
