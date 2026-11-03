# 回环 WebSocket 认证与重连；网络断开不删除本地未确认消息。认证令牌不得出现在诊断输出或聊天内容。
"""Loopback network thread. UI commands are queued, never executed here."""
import json
import queue
import time
import threading
from urllib.parse import urlparse


class BridgeProtocol:
    """只解释网络帧并投递 UI 命令，不在网络线程访问 COM/UIA。
    ACK 表示服务端已接受事件，可以删本地收件；NACK 保留原记录供重试并记录诊断，不能当作 ACK。
    """

    def __init__(self, store, enqueue_command):
        self.store, self.enqueue_command = store, enqueue_command
        self.delivery = {'acknowledged': 0, 'rejected': 0, 'lastError': None}

    def diagnostics(self):
        return dict(self.delivery)

    def receive(self, message):
        """处理已经解码的 WebSocket 对象；仅 ack 删除对应 eventId，configure/request 进入桌面命令队列。
        未知帧不触发桌面操作；拒收详情最多保留 500 字，此处不读取或拼接本地认证令牌。
        """
        if not isinstance(message, dict):
            raise ValueError('帧必须为对象')
        kind = message.get('type')
        if kind == 'ack' and isinstance(message.get('eventId'), str):
            self.store.ack(message['eventId'])
            self.delivery['acknowledged'] += 1
        elif kind == 'nack':
            self.delivery['rejected'] += 1
            self.delivery['lastError'] = str(message.get('detail') or '服务端拒收消息，保留待重试')[
                :500
            ]
        elif kind in {'configure', 'request'}:
            self.enqueue_command(message)
        # nack deliberately retains the durable event for retransmission.

    def replay(self):
        return [{'type': 'event', 'event': event} for event in self.store.pending()]


class ImageUploadWorkers:
    """两个 HTTP 上传线程跨 WebSocket 重连存活，避免慢图片阻塞控制帧和事件 ACK。
    SQLite 是待上传数据的事实来源；active 集合只防止本进程两线程同时上传同一 attachmentId。
    """

    def __init__(self, endpoint, token, store):
        self.endpoint, self.token, self.store = endpoint, token, store
        self.stop = threading.Event()
        self.connected = threading.Event()
        self.lock = threading.Lock()
        self.active = set()
        self.retry_at = {}
        self.counts = {'attempts': 0, 'uploaded': 0, 'failures': 0, 'discarded': 0}
        self.last_error = None
        self.threads = [
            threading.Thread(target=self._run, name=f'bridge-upload-{n}', daemon=True)
            for n in range(2)
        ]

    def start(self):
        for thread in self.threads:
            thread.start()

    def close(self):
        self.connected.clear()
        self.stop.set()
        for thread in self.threads:
            thread.join()

    def diagnostics(self):
        with self.lock:
            return {
                **self.counts,
                'active': len(self.active),
                'capacity': 2,
                'lastError': self.last_error,
            }

    def _claim(self):
        """锁内认领一个已满足事件 ACK、未在上传且退避到期的附件。
        使用 monotonic 判断重试间隔，避免系统校时令任务过早或长期不重试。
        """
        with self.lock:
            if self.stop.is_set() or not self.connected.is_set():
                return None
            for upload in self.store.pending_image_uploads(acknowledged_only=True):
                aid = upload['attachmentId']
                if aid not in self.active and time.monotonic() >= self.retry_at.get(aid, 0):
                    self.active.add(aid)
                    self.counts['attempts'] += 1
                    return upload
        return None

    def _run(self):
        """持续上传认领附件；仅 200/400/403/410 视为终态并移除本地载荷。
        网络异常和其他响应保留数据，五秒后重试；finally 总会解除 active 占用，避免附件永久卡住。
        """
        from urllib.request import Request, urlopen
        from urllib.error import HTTPError

        while not self.stop.is_set():
            upload = self._claim()
            if upload is None:
                self.stop.wait(0.1)
                continue
            aid = upload['attachmentId']
            status = None
            failure = None
            try:
                request = Request(
                    self.endpoint,
                    data=json.dumps(upload).encode(),
                    headers={
                        'Authorization': 'Bearer ' + self.token,
                        'Content-Type': 'application/json',
                    },
                    method='POST',
                )
                with urlopen(request, timeout=8) as response:
                    status = response.status
            except HTTPError as error:
                status = error.code
                error.close()
            except Exception as error:
                failure = type(error).__name__
            try:
                terminal = status in (200, 400, 403, 410)
                if terminal:
                    self.store.ack_image_upload(aid)
                with self.lock:
                    if status == 200:
                        self.counts['uploaded'] += 1
                    else:
                        self.counts['failures'] += 1
                        self.last_error = failure or f'HTTP {status}'
                        if terminal:
                            self.counts['discarded'] += 1
                    if terminal:
                        self.retry_at.pop(aid, None)
                    else:
                        self.retry_at[aid] = time.monotonic() + 5
            finally:
                with self.lock:
                    self.active.discard(aid)


def run_network(url, token, store, commands, outgoing, stop):
    """运行独立的回环网络循环，认证令牌只放 Authorization 头。
    状态缓存跨重连恢复；每五秒重放未 ACK 事件，指令经队列交给唯一 UI 线程。
    指数退避最多十秒；退出先等待 HTTP 上传线程结束，再允许调用方关闭 SQLite。
    """
    from websockets.sync.client import connect

    parsed = urlparse(url)
    if parsed.scheme != 'ws' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('桥接仅允许本机回环 ws 地址')
    protocol = BridgeProtocol(store, commands.put)
    cached_status = {
        'type': 'status',
        'connected': False,
        'capabilities': {},
        'detail': '桥接正在检查现有微信窗口',
    }
    delay = 1
    uploads = ImageUploadWorkers('http://' + parsed.netloc + '/bridge/attachments', token, store)
    uploads.start()

    def status_frame(frame):
        return {
            **frame,
            'diagnostics': {
                **frame.get('diagnostics', {}),
                'imageUploads': uploads.diagnostics(),
                'eventDelivery': protocol.diagnostics(),
            },
        }

    try:
        while not stop.is_set():
            try:
                with connect(
                    url,
                    additional_headers={'Authorization': 'Bearer ' + token},
                    open_timeout=5,
                    close_timeout=2,
                    max_size=300000,
                    proxy=None,
                ) as socket:
                    delay, replay_at = 1, 0
                    uploads.connected.set()
                    socket.send(json.dumps(status_frame(cached_status), ensure_ascii=False))
                    while not stop.is_set():
                        for _ in range(100):
                            try:
                                frame = outgoing.get_nowait()
                            except queue.Empty:
                                break
                            if frame.get('type') == 'status':
                                cached_status = frame
                                frame = status_frame(frame)
                            socket.send(json.dumps(frame, ensure_ascii=False))
                        if time.monotonic() >= replay_at:
                            for frame in protocol.replay():
                                socket.send(json.dumps(frame, ensure_ascii=False))
                            replay_at = time.monotonic() + 5
                        try:
                            raw = socket.recv(timeout=0.2)
                            protocol.receive(json.loads(raw))
                        except TimeoutError:
                            pass
            except Exception as exc:
                uploads.connected.clear()
                print(
                    json.dumps(
                        {'type': 'transport', 'connected': False, 'detail': type(exc).__name__},
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                stop.wait(delay)
                delay = min(delay * 2, 10)
    finally:
        uploads.close()
