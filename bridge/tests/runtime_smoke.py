"""Manual real-runtime smoke: empty whitelist, local fixture server, no chat reads."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from websockets.sync.server import serve

ROOT = Path(__file__).resolve().parents[2]


def main():
    TMP = ROOT / 'artifacts' / 'tmp'
    TMP.mkdir(parents=True, exist_ok=True)
    observed, errors, done = [], [], threading.Event()
    def handler(socket):
        try:
            assert socket.request.headers.get('Authorization') == 'Bearer runtime-fixture-token'
            socket.send(json.dumps({'type': 'configure', 'chats': []}))
            socket.send(json.dumps({'type': 'request', 'requestId': 'fixture-list', 'action': 'list', 'payload': {}}))
            listed, diagnosed = False, False
            for _ in range(20):
                frame = json.loads(socket.recv(timeout=8))
                observed.append(frame)
                if frame.get('type') == 'status' and 'groupListening' in frame.get('capabilities', {}): diagnosed = True
                if frame.get('type') == 'result' and frame.get('requestId') == 'fixture-list':
                    assert frame['result']['chats'] == []
                    listed = True
                if diagnosed and listed:
                    done.set()
                    return
        except Exception as exc:
            errors.append(repr(exc)); done.set()

    with tempfile.TemporaryDirectory(dir=TMP) as directory, serve(handler, '127.0.0.1', 0) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f'ws://127.0.0.1:{server.socket.getsockname()[1]}/bridge'
        env = {**os.environ, 'BRIDGE_TOKEN': 'runtime-fixture-token'}
        process = subprocess.Popen([sys.executable, '-X', 'utf8', str(ROOT / 'bridge' / 'main.py'), 'run',
                                    '--url', url, '--store', str(Path(directory) / 'bridge.sqlite')],
                                   cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            if not done.wait(12): errors.append('real bridge runtime did not answer within 12 seconds')
        finally:
            process.terminate()
            stdout, stderr = process.communicate(timeout=8)
            server.shutdown(); thread.join(timeout=3)
    result = {'passed': not errors, 'emptyWhitelist': True, 'sentWechatMessages': 0, 'frames': observed,
              'errors': errors, 'runtimeStdout': stdout.decode('utf-8', errors='replace'),
              'runtimeStderr': stderr.decode('utf-8', errors='replace')}
    (ROOT / 'artifacts' / 'bridge-runtime-smoke.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'passed': result['passed'], 'frameTypes': [x.get('type') for x in observed], 'errors': errors}, ensure_ascii=False))
    if errors: raise SystemExit(1)


if __name__ == '__main__': main()
