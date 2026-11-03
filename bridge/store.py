# SQLite 收件箱与发送账本；事务提交后才上报。崩溃重启保留未确认事件，发送中断不得直接当成未发送重试。
"""Local durable inbox and send ledger. No wx4py dependency; independently testable."""
import json
import sqlite3
import threading
import uuid
import hashlib
from datetime import datetime, timezone
from pathlib import Path


def reconcile(previous, current):
    """比较旧快照尾部与当前快照头部，返回新增行和是否存在断层。
    只接受连续重叠，不按消息文字去重；找不到重叠时返回空新增并标记断层，避免把历史重新上报。
    """
    if not previous or previous == current:
        return [], False
    for size in range(min(len(previous), len(current)), 0, -1):
        if previous[-size:] == current[:size]:
            return current[size:], False
    return [], True


def snapshot_fingerprints(rows):
    """将用于界面对齐的行转换为 SHA-256 指纹，避免 SQLite 快照长期保存聊天原文。
    已是单一 fingerprint 对象时直接沿用，以兼容旧快照升级和后续重复保存。
    """
    return [
        (
            row
            if isinstance(row, dict) and set(row) == {'fingerprint'}
            else {
                'fingerprint': hashlib.sha256(
                    json.dumps(row, sort_keys=True, ensure_ascii=False).encode()
                ).hexdigest()
            }
        )
        for row in rows
    ]


class BridgeStore:
    """桥接本地持久化边界，负责收件箱、待上传图片、发送账本和群快照。
    SQLite 连接允许跨线程使用，但每次访问由 RLock 串行化；WAL 允许备份/读取不必长期阻塞写入。
    with self.db 在正常退出时提交、异常时回滚；必须先提交收件，再通过网络发送，ACK 后才删除。
    """

    def __init__(self, filename):
        """打开并兼容升级本地状态，不连接微信或服务端。
        字段目的：inbox.seq 是重放顺序，id 是事件幂等键，payload 是待确认正文，received_at 用于保留期兜底；
        sends.id 是 commandId，status/detail 是发送结果，context 绑定原目标防止同一指令换群重试；
        image_uploads.id 是 attachmentId，payload 保存待上传图片，created_at 用于过期；
        snapshots.chat_id 是群隔离键，payload 只保存界面对齐指纹。
        重启时 executing 改为 unknown：操作可能已经作用到微信，不能假设未发送。
        """
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.expired_inbox_count = 0
        self.db = sqlite3.connect(filename, check_same_thread=False)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript(
            '''
            CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, payload TEXT);
            CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY, status TEXT, detail TEXT);
            CREATE TABLE IF NOT EXISTS image_uploads (id TEXT PRIMARY KEY, payload TEXT, created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshots (chat_id TEXT PRIMARY KEY, payload TEXT);
        '''
        )
        if 'context' not in {row[1] for row in self.db.execute('PRAGMA table_info(sends)')}:
            self.db.execute("ALTER TABLE sends ADD COLUMN context TEXT NOT NULL DEFAULT ''")
        if 'received_at' not in {row[1] for row in self.db.execute('PRAGMA table_info(inbox)')}:
            self.db.execute('ALTER TABLE inbox ADD COLUMN received_at TEXT')
        self.db.execute(
            "UPDATE inbox SET received_at=? WHERE received_at IS NULL",
            (datetime.now(timezone.utc).isoformat(),),
        )
        for chat_id, payload in self.db.execute('SELECT chat_id,payload FROM snapshots').fetchall():
            self.db.execute(
                'UPDATE snapshots SET payload=? WHERE chat_id=?',
                (json.dumps(snapshot_fingerprints(json.loads(payload))), chat_id),
            )
        # An action interrupted after UI invocation cannot safely be replayed.
        self.db.execute(
            "UPDATE sends SET status='unknown',detail='桥接重启，发送结果需核查' WHERE status='executing'"
        )
        self.db.commit()
        self.expire_inbox()

    def enqueue(self, payload):
        """事务内保存事件并返回稳定 eventId；INSERT OR IGNORE 仅按事件键去重，不合并内容相同的独立消息。"""
        with self.lock, self.db:
            event_id = payload.get('eventId') or str(uuid.uuid4())
            payload = {**payload, 'eventId': event_id}
            self.db.execute(
                'INSERT OR IGNORE INTO inbox(id,payload,received_at) VALUES (?,?,?)',
                (
                    event_id,
                    json.dumps(payload, ensure_ascii=False),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            return event_id

    def pending(self):
        self.expire_inbox()
        with self.lock:
            return [
                json.loads(row[0])
                for row in self.db.execute('SELECT payload FROM inbox ORDER BY seq LIMIT 100')
            ]

    def expire_inbox(self):
        """清理超过 30 天的未确认正文；取观察时间与收件时间较早值，避免未来时间戳无限延长保留。
        累计过期数量供诊断展示；过期删除是保留期策略，不代表服务端已经 ACK。
        """
        with self.lock, self.db:
            count = self.db.execute(
                "DELETE FROM inbox WHERE min(coalesce(julianday(json_extract(payload,'$.observedAt')),julianday(received_at)),julianday(received_at)) < julianday('now','-30 days')"
            ).rowcount
            self.expired_inbox_count += count
            return count

    def save_image_upload(self, payload):
        with self.lock, self.db:
            self.db.execute(
                'INSERT OR IGNORE INTO image_uploads(id,payload,created_at) VALUES(?,?,?)',
                (
                    payload['attachmentId'],
                    json.dumps(payload),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    def pending_image_uploads(self, acknowledged_only=False):
        """返回至多十张待上传图片，可限制为其所属事件已获 ACK 的图片。
        先确认事件再上传附件，防止服务端尚无消息记录时错误拒收；过期图片在同一事务中移除。
        """
        with self.lock, self.db:
            self.db.execute(
                "DELETE FROM image_uploads WHERE julianday(created_at)<julianday('now','-30 days')"
            )
            ready = (
                "WHERE NOT EXISTS(SELECT 1 FROM inbox WHERE inbox.id=json_extract(image_uploads.payload,'$.eventId'))"
                if acknowledged_only
                else ''
            )
            return [
                json.loads(row[0])
                for row in self.db.execute(
                    'SELECT payload FROM image_uploads ' + ready + ' ORDER BY created_at LIMIT 10'
                )
            ]

    def ack_image_upload(self, attachment_id):
        with self.lock, self.db:
            self.db.execute('DELETE FROM image_uploads WHERE id=?', (attachment_id,))

    def ack(self, event_id):
        with self.lock, self.db:
            self.db.execute('DELETE FROM inbox WHERE id=?', (event_id,))

    def is_event_pending(self, event_id):
        with self.lock:
            return (
                self.db.execute('SELECT 1 FROM inbox WHERE id=?', (event_id,)).fetchone()
                is not None
            )

    def begin_send(self, command_id, context=''):
        """以 commandId 原子认领发送资格，返回是否成功。
        只有旧状态明确为 not_sent 且 context 未变才允许重试；unknown/sent/executing 都不得再次点击发送。
        ON CONFLICT 的 WHERE 将状态与目标检查放进同一条语句，避免并发先查后写竞态。
        """
        with self.lock, self.db:
            # Only a positively confirmed no-send result is safe to claim again.
            # The conditional upsert also keeps retries atomic and target-bound.
            cursor = self.db.execute(
                """
                INSERT INTO sends(id,status,detail,context) VALUES (?,'executing','',?)
                ON CONFLICT(id) DO UPDATE SET status='executing',detail=''
                WHERE sends.status='not_sent' AND sends.context=excluded.context
            """,
                (command_id, context),
            )
            return cursor.rowcount == 1

    def finish_send(self, command_id, status, detail=''):
        """记录发送结果，供重连后相同 commandId 查询；结果为 unknown 时保留人工核查状态，不自动重发。"""
        with self.lock, self.db:
            self.db.execute(
                'INSERT INTO sends(id,status,detail) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,detail=excluded.detail',
                (command_id, status, detail),
            )

    def send_context(self, command_id):
        with self.lock:
            row = self.db.execute('SELECT context FROM sends WHERE id=?', (command_id,)).fetchone()
            return row[0] if row else None

    def send_result(self, command_id):
        with self.lock:
            row = self.db.execute(
                'SELECT status,detail FROM sends WHERE id=?', (command_id,)
            ).fetchone()
            return {'status': row[0], 'detail': row[1]} if row else None

    def snapshot(self, chat_id):
        with self.lock:
            row = self.db.execute(
                'SELECT payload FROM snapshots WHERE chat_id=?', (chat_id,)
            ).fetchone()
            return json.loads(row[0]) if row else []

    def has_snapshot(self, chat_id):
        with self.lock:
            return (
                self.db.execute('SELECT 1 FROM snapshots WHERE chat_id=?', (chat_id,)).fetchone()
                is not None
            )

    def save_snapshot(self, chat_id, value):
        with self.lock, self.db:
            self.db.execute(
                'INSERT OR REPLACE INTO snapshots VALUES (?,?)',
                (chat_id, json.dumps(snapshot_fingerprints(value), ensure_ascii=False)),
            )

    def commit_observation(self, chat_id, snapshot, events, send_result=None, image_uploads=()):
        """在单一事务中提交群快照、所有新事件、图片载荷及可选发送确认。
        快照是下次观察游标；若先推进快照再写事件，崩溃后会永久漏消息，因此这些记录必须一起提交。
        send_result 是 (commandId, status, detail)，用于把本地回显确认和游标推进绑定在一起。
        """
        with self.lock, self.db:
            for upload in image_uploads:
                self.db.execute(
                    'INSERT OR IGNORE INTO image_uploads(id,payload,created_at) VALUES(?,?,?)',
                    (
                        upload['attachmentId'],
                        json.dumps(upload),
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
            for payload in events:
                self.db.execute(
                    'INSERT OR IGNORE INTO inbox(id,payload,received_at) VALUES (?,?,?)',
                    (
                        payload['eventId'],
                        json.dumps(payload, ensure_ascii=False),
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
            self.db.execute(
                'INSERT OR REPLACE INTO snapshots VALUES (?,?)',
                (chat_id, json.dumps(snapshot_fingerprints(snapshot), ensure_ascii=False)),
            )
            if send_result:
                command_id, status, detail = send_result
                self.db.execute(
                    'UPDATE sends SET status=?,detail=? WHERE id=?', (status, detail, command_id)
                )

    def close(self):
        with self.lock:
            self.db.close()
