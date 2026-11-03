# 独立桥接入口；仅操作已授权现有桌面窗口。实验探测默认关闭，常规监听以服务端配置群列表为准。
"""Run with .venv/Scripts/python.exe bridge/main.py diagnose|run|probe|test-send."""
import argparse
import json
import os
from pathlib import Path
import queue
import signal
import sys
import threading
import time
import uuid
from diagnostics import inventory
from engine import BridgeEngine, binding_key
from store import BridgeStore
from transport import run_network

ROOT = Path(__file__).resolve().parent
TEST_GROUP = os.environ.get('WECHATBOT_TEST_GROUP', '').strip()


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2), flush=True)


class DesktopLease:
    """用命名 Windows Mutex 阻止两个桥接进程同时操作当前桌面。
    这里检测的是命名对象已经存在（错误码 183），不是通过等待互斥量来排队；冲突直接拒绝启动。
    """

    def __enter__(self):
        import win32api
        import win32event

        self.handle = win32event.CreateMutex(None, False, 'Local\\WeChatBotBridgeUI')
        if win32api.GetLastError() == 183:
            self.handle.Close()
            raise RuntimeError('已有桥接进程操作微信，请先停止旧桥接')
        return self

    def __exit__(self, *_):
        self.handle.Close()


def ui_worker(store, commands, outgoing, stop):
    """唯一 UIA/COM 工作线程，负责绑定、读取、发送和资料卡操作。
    UIAutomation 必须在使用它的线程初始化，并在 finally 释放；网络线程只入队，不能直接调用 adapter。
    失联重试和绑定重试只重新检查已有窗口，不登录或重启微信；发送异常保守返回 unknown。
    """
    from wx4py.core import uiautomation as uia
    from wx_adapter import WxAdapter

    uia.InitializeUIAutomationInCurrentThread()
    try:
        adapter = WxAdapter()
        engine = BridgeEngine(store, adapter)
        desired, retry_at, status_at, bind_retry_at = [], 0, 0, 0
        while not stop.is_set():
            now = time.monotonic()
            if not adapter.status()['connected'] and now >= retry_at:
                try:
                    adapter.attach()
                    engine.configure(desired)
                except Exception as exc:
                    adapter.detail = str(exc)
                retry_at = now + 10
                outgoing.put(engine.status())
            elif adapter.status()['connected'] and engine.binding_errors and now >= bind_retry_at:
                try:
                    engine.configure(desired)
                except Exception as exc:
                    outgoing.put({'type': 'diagnostic', 'detail': f'授权群重新绑定失败：{exc}'})
                bind_retry_at = now + 30
            try:
                command = commands.get(timeout=0.2)
                if command.get('type') == 'configure':
                    try:
                        desired = command.get('chats', [])
                        if not isinstance(desired, list):
                            raise ValueError('群配置必须为列表')
                        engine.configure(desired)
                    except Exception as exc:
                        outgoing.put({'type': 'diagnostic', 'detail': f'群配置失败：{exc}'})
                    outgoing.put(engine.status())
                elif command.get('type') == 'request':
                    try:
                        outgoing.put(engine.request(command))
                    except Exception as exc:
                        outgoing.put(
                            {
                                'type': 'result',
                                'requestId': command.get('requestId'),
                                'result': {
                                    'status': (
                                        'unknown'
                                        if command.get('action') in ('send', 'send_image')
                                        else 'not_sent'
                                    ),
                                    'detail': f'桥接异常，请核查实际结果：{type(exc).__name__}',
                                },
                            }
                        )
            except queue.Empty:
                pass
            for detail in engine.poll():
                outgoing.put({'type': 'diagnostic', 'detail': detail})
            if now >= status_at:
                outgoing.put(engine.status())
                status_at = now + 10
    finally:
        uia.UninitializeUIAutomationInCurrentThread()


def run(args):
    """启动桌面线程与网络线程，以共享 Event 通知退出。
    令牌取自环境或本地文件，不写入状态输出；桌面租约阻止并行桥接。
    网络线程退出前仍可能提交图片 ACK，必须先 join 它再关闭 store。
    """
    from dotenv import load_dotenv

    load_dotenv(ROOT.parent / '.env', override=False)
    token_file = Path(
        os.environ.get('BRIDGE_TOKEN_FILE', str(ROOT.parent / 'data' / 'bridge.token'))
    )
    token = os.environ.get('BRIDGE_TOKEN') or (
        token_file.read_text(encoding='utf-8').strip() if token_file.exists() else ''
    )
    if not token:
        raise RuntimeError('缺少BRIDGE_TOKEN或data/bridge.token；请先启动本地服务')
    store = BridgeStore(args.store)
    commands, outgoing, stop = queue.Queue(), queue.Queue(), threading.Event()

    def terminate(*_):
        stop.set()

    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGTERM, terminate)
    worker = threading.Thread(
        target=ui_worker, args=(store, commands, outgoing, stop), name='wechat-uia', daemon=True
    )
    network = threading.Thread(
        target=run_network,
        args=(args.url, token, store, commands, outgoing, stop),
        name='bridge-network',
        daemon=True,
    )
    with DesktopLease():
        worker.start()
        network.start()
        emit(
            {
                'type': 'bridge',
                'running': True,
                'url': args.url,
                'store': str(Path(args.store).resolve()),
            }
        )
        while not stop.wait(0.5):
            if not worker.is_alive() or not network.is_alive():
                stop.set()
                raise RuntimeError('桥接工作线程已退出，请查看启动日志')
        # The network owns HTTP workers; let it join in-flight requests before
        # closing SQLite, which their completion still needs to acknowledge.
        worker.join(timeout=8)
        network.join()
    store.close()


def probe(args):
    """对专门测试群执行诊断或随机标记发送，使用隔离状态文件。
    没有显式配置 WECHATBOT_TEST_GROUP 或目标不一致时拒绝操作；probe 只绑定读取，test-send 才实际发送。
    """
    from wx_adapter import WxAdapter

    if not TEST_GROUP or args.group != TEST_GROUP:
        raise RuntimeError('先配置 WECHATBOT_TEST_GROUP 并显式指定同名测试群')
    with DesktopLease():
        adapter = WxAdapter()
        try:
            adapter.attach()
        except Exception as exc:
            return {
                'status': 'not_sent' if args.action == 'test-send' else 'unsupported',
                'group': args.group,
                'detail': str(exc),
                'diagnostics': adapter.diagnostics,
                'sentMarker': None,
            }
        store = BridgeStore(args.store)
        try:
            engine = BridgeEngine(store, adapter)
            chat = {
                'id': str(uuid.uuid5(uuid.NAMESPACE_URL, binding_key(args.group))),
                'name': args.group,
                'bindingKey': binding_key(args.group),
            }
            state = engine.configure([chat])
            if args.action == 'probe':
                return {
                    'status': 'bound' if not engine.binding_errors else 'unsupported',
                    'group': args.group,
                    'bridge': state,
                    'visibleItems': len(store.snapshot(chat['id'])),
                    'sentMarker': None,
                }
            marker = f'[WeChatBot连接测试 {uuid.uuid4().hex[:10]}] 仅验证本地桥接收发。'
            result = engine.send(
                {
                    'commandId': str(uuid.uuid4()),
                    'chatId': chat['id'],
                    'bindingKey': chat['bindingKey'],
                    'text': marker,
                }
            )
            return {
                **result,
                'group': args.group,
                'sentMarker': marker if result['status'] != 'not_sent' else None,
                'echoed': any(e['isSelf'] and e['content'] == marker for e in store.pending()),
            }
        finally:
            store.close()


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(
        description='安全接入现有微信4.x窗口；不更改系统设置，不重启微信'
    )
    parser.add_argument('action', choices=['diagnose', 'run', 'probe', 'test-send'])
    parser.add_argument('--group', default=TEST_GROUP)
    parser.add_argument(
        '--store', help='SQLite状态文件；实际群探测默认使用隔离的connection-test.sqlite'
    )
    parser.add_argument('--url', default=os.environ.get('BRIDGE_URL', 'ws://127.0.0.1:4310/bridge'))
    parser.add_argument('--output', help='保存诊断JSON（不包含聊天内容）')
    args = parser.parse_args()
    args.store = args.store or str(
        ROOT / 'state' / ('bridge.sqlite' if args.action == 'run' else 'connection-test.sqlite')
    )
    try:
        if args.action == 'run':
            run(args)
            return
        result = inventory() if args.action == 'diagnose' else probe(args)
        if args.output:
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8'
            )
        emit(result)
    except Exception as exc:
        emit({'status': 'error', 'detail': str(exc), 'error': type(exc).__name__})
        sys.exit(1)


if __name__ == '__main__':
    main()
