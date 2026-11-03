import json
from pathlib import Path
import queue
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request as HttpRequest
from websockets.sync.server import serve
from store import BridgeStore
from transport import run_network, ImageUploadWorkers, BridgeProtocol

TMP = Path(__file__).resolve().parents[2] / 'artifacts' / 'tmp'
TMP.mkdir(parents=True, exist_ok=True)


class TransportIntegrationTests(unittest.TestCase):
    def test_rejected_head_events_do_not_starve_an_acknowledged_upload(self):
        store = BridgeStore(':memory:')
        try:
            for n in range(11):
                event = store.enqueue({'eventId': f'event-{n}', 'type': 'image'})
                store.save_image_upload(
                    {'attachmentId': str(n), 'eventId': event, 'data': 'fixture'}
                )
            store.ack('event-10')
            workers = ImageUploadWorkers('http://127.0.0.1:1/bridge/attachments', 'token', store)
            workers.connected.set()
            self.assertEqual(workers._claim()['attachmentId'], '10')
        finally:
            store.close()

    def test_nack_retains_event_and_exposes_the_protocol_error(self):
        store = BridgeStore(':memory:')
        try:
            event = store.enqueue({'eventId': 'bad', 'type': 'image'})
            protocol = BridgeProtocol(store, lambda value: None)
            protocol.receive(
                {
                    'type': 'nack',
                    'eventId': event,
                    'code': 'invalid_event',
                    'detail': '消息字段不合法：image.reason',
                }
            )
            self.assertEqual(len(store.pending()), 1)
            self.assertEqual(protocol.diagnostics()['rejected'], 1)
            self.assertIn('image.reason', protocol.diagnostics()['lastError'])
        finally:
            store.close()

    def test_upload_waits_for_its_event_ack(self):
        store = BridgeStore(':memory:')
        try:
            event = store.enqueue({'eventId': 'event', 'type': 'image'})
            store.save_image_upload({'attachmentId': 'image', 'eventId': event, 'data': 'fixture'})
            workers = ImageUploadWorkers('http://127.0.0.1:1/bridge/attachments', 'token', store)
            workers.connected.set()
            self.assertIsNone(workers._claim())
            store.ack(event)
            self.assertEqual(workers._claim()['attachmentId'], 'image')
        finally:
            store.close()

    def test_http_terminal_errors_conflict_backoff_and_network_failure_persist(self):
        calls = {}
        lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                aid = json.loads(self.rfile.read(int(self.headers['Content-Length'])))[
                    'attachmentId'
                ]
                with lock:
                    calls.setdefault(aid, []).append(time.monotonic())
                    count = len(calls[aid])
                if aid == 'network':
                    self.close_connection = True
                    return
                status = int(aid)
                if aid == '409' and count > 1:
                    status = 200
                self.send_response(status)
                self.end_headers()

        def wait_for(predicate, timeout=3):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if predicate():
                    return True
                time.sleep(0.02)
            return False

        with tempfile.TemporaryDirectory(dir=TMP) as directory:
            path = str(Path(directory) / 'uploads.db')
            store = BridgeStore(path)
            for aid in ('200', '400', '403', '410', '409', 'network'):
                store.save_image_upload({'attachmentId': aid, 'data': 'private-bytes'})
            http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            serving = threading.Thread(target=http.serve_forever, daemon=True)
            serving.start()
            workers = ImageUploadWorkers(
                f'http://127.0.0.1:{http.server_port}/bridge/attachments', 'token', store
            )
            workers.connected.set()
            workers.start()
            try:
                self.assertTrue(
                    wait_for(
                        lambda: workers.diagnostics()['attempts'] == 6
                        and workers.diagnostics()['active'] == 0
                    )
                )
                self.assertEqual(
                    sorted(x['attachmentId'] for x in store.pending_image_uploads()),
                    ['409', 'network'],
                )
                stats = workers.diagnostics()
                self.assertEqual(stats['uploaded'], 1)
                self.assertEqual(stats['discarded'], 3)
                self.assertEqual(stats['failures'], 5)
                self.assertNotIn('private-bytes', str(stats))
                time.sleep(0.25)
                self.assertEqual(len(calls['409']), 1, '409 must back off')
                self.assertTrue(wait_for(lambda: workers.diagnostics()['uploaded'] == 2, 6))
                self.assertGreaterEqual(calls['409'][1] - calls['409'][0], 4.9)
            finally:
                workers.close()
                http.shutdown()
                http.server_close()
                serving.join(3)
                store.close()
            reopened = BridgeStore(path)
            try:
                self.assertEqual(
                    [x['attachmentId'] for x in reopened.pending_image_uploads()], ['network']
                )
            finally:
                reopened.close()

    def test_two_slow_http_uploads_do_not_block_ws_control_or_duplicate_on_reconnect(self):
        store = BridgeStore(':memory:')
        event_id = store.enqueue({'chatId': 'fixture', 'content': 'fixture'})
        for n in range(3):
            store.save_image_upload({'attachmentId': str(n), 'data': 'fixture'})
        commands, outgoing, stop = queue.Queue(), queue.Queue(), threading.Event()
        release, two_started, controlled = threading.Event(), threading.Event(), threading.Event()
        calls = []
        lock = threading.Lock()
        connections = []
        errors = []

        class HttpHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                with lock:
                    calls.append(payload['attachmentId'])
                    if len(calls) == 2:
                        two_started.set()
                release.wait(5)
                self.send_response(200)
                self.end_headers()

        http = ThreadingHTTPServer(('127.0.0.1', 0), HttpHandler)
        http_thread = threading.Thread(target=http.serve_forever, daemon=True)
        http_thread.start()

        def route_request(url, **kwargs):
            return HttpRequest(f'http://127.0.0.1:{http.server_port}/bridge/attachments', **kwargs)

        def handler(socket):
            try:
                connections.append(True)
                if not two_started.wait(2):
                    return
                if len(connections) == 1:
                    socket.close()
                    return
                socket.send(json.dumps({'type': 'ack', 'eventId': event_id}))
                socket.send(
                    json.dumps({'type': 'request', 'requestId': 'control', 'action': 'list'})
                )
                while True:
                    frame = json.loads(socket.recv(timeout=2))
                    if frame.get('requestId') == 'response':
                        controlled.set()
                        stop.wait(4)
                        return
            except Exception as exc:
                if not stop.is_set():
                    errors.append(repr(exc))

        try:
            with serve(handler, '127.0.0.1', 0) as server, patch(
                'urllib.request.Request', side_effect=route_request
            ):
                serving = threading.Thread(target=server.serve_forever, daemon=True)
                serving.start()
                network = threading.Thread(
                    target=run_network,
                    args=(
                        f'ws://127.0.0.1:{server.socket.getsockname()[1]}/bridge',
                        'token',
                        store,
                        commands,
                        outgoing,
                        stop,
                    ),
                    daemon=True,
                )
                network.start()
                try:
                    self.assertTrue(two_started.wait(3), 'two uploads must start concurrently')
                    command = commands.get(timeout=3)
                    self.assertEqual(command['requestId'], 'control')
                    outgoing.put({'type': 'response', 'requestId': 'response'})
                    self.assertTrue(controlled.wait(1), 'WS send blocked by HTTP')
                    self.assertEqual(store.pending(), [], 'WS ack blocked by HTTP')
                    self.assertFalse(release.is_set())
                    self.assertEqual(
                        sorted(calls), ['0', '1'], 'limit two, no duplicate across reconnect'
                    )
                    self.assertEqual(errors, [])
                finally:
                    stop.set()
                    release.set()
                    network.join(10)
                    server.shutdown()
                    serving.join(3)
                    self.assertFalse(network.is_alive(), 'network must join upload workers')
                self.assertFalse(
                    any(t.name.startswith('bridge-upload-') for t in threading.enumerate())
                )
        finally:
            release.set()
            http.shutdown()
            http.server_close()
            http_thread.join(3)
            store.close()

    def test_loopback_auth_reconnect_replay_ack_and_command_queue(self):
        with tempfile.TemporaryDirectory(dir=TMP) as directory:
            store = BridgeStore(str(Path(directory) / 'bridge.db'))
            event_id = store.enqueue({'content': 'test fixture', 'chatId': 'fixture'})
            commands, outgoing, stop = queue.Queue(), queue.Queue(), threading.Event()
            done, seen, auth, errors = threading.Event(), [], [], []

            def handler(socket):
                try:
                    auth.append(socket.request.headers.get('Authorization'))
                    socket.send(json.dumps({'type': 'configure', 'chats': []}))
                    while True:
                        frame = json.loads(socket.recv(timeout=4))
                        if frame.get('type') == 'event':
                            seen.append(frame['event']['eventId'])
                            if len(seen) == 1:
                                socket.close(1000, 'intentional reconnect fixture')
                                return
                            socket.send(json.dumps({'type': 'ack', 'eventId': event_id}))
                            socket.send(
                                json.dumps(
                                    {
                                        'type': 'request',
                                        'requestId': 'list-1',
                                        'action': 'list',
                                        'payload': {},
                                    }
                                )
                            )
                            done.set()
                            stop.wait(3)
                            return
                except Exception as exc:
                    errors.append(repr(exc))
                    done.set()

            with serve(handler, '127.0.0.1', 0) as server:
                server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                server_thread.start()
                url = f'ws://127.0.0.1:{server.socket.getsockname()[1]}/bridge'
                network = threading.Thread(
                    target=run_network,
                    args=(url, 'test-token', store, commands, outgoing, stop),
                    daemon=True,
                )
                network.start()
                try:
                    self.assertTrue(done.wait(8), 'network replay did not finish')
                    deadline = time.monotonic() + 3
                    while store.pending() and time.monotonic() < deadline:
                        stop.wait(0.02)
                    self.assertEqual(errors, [])
                    self.assertEqual(seen[:2], [event_id, event_id])
                    self.assertTrue(all(x == 'Bearer test-token' for x in auth))
                    self.assertEqual(store.pending(), [])
                    received = []
                    while not commands.empty():
                        received.append(commands.get_nowait())
                    self.assertTrue(any(x.get('requestId') == 'list-1' for x in received))
                finally:
                    stop.set()
                    network.join(timeout=5)
                    server.shutdown()
                    server_thread.join(timeout=3)
                    store.close()


if __name__ == '__main__':
    unittest.main()
