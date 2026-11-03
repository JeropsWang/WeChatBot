import hashlib
import unittest
import sqlite3
import tempfile
import json
from datetime import datetime, timedelta, timezone
from engine import BridgeEngine
from store import BridgeStore
from test_protocol import FakeAdapter, G1, G2, item


class ReplyAdapter(FakeAdapter):
    def __init__(self):
        super().__init__()
        self.probes = 0

    def identity_message_observation(self, name, chat_id, session_id, text, runtime):
        rows = [row for row in self.rows[name] if row.get('_runtimeId') == runtime and row['name'] == text]
        if len(rows) != 1:
            return None
        return {'chatId': chat_id, 'sessionId': session_id, 'runtimeId': runtime,
                'rect': rows[0]['_rect'], 'textHash': hashlib.sha256(text.encode()).hexdigest(),
                'imageHash': rows[0].get('_appearance', 'a' * 64), 'visible': True}

    def identity_message(self, name, chat_id, session_id, text, runtime, rect, expected=None):
        self.probes += 1
        return {'status': 'candidate', 'name': '群友', 'appearanceHash': expected['imageHash']}


class ReplyIdentityTests(unittest.TestCase):
    def setUp(self):
        self.store = BridgeStore(':memory:')
        self.adapter = ReplyAdapter()
        self.engine = BridgeEngine(self.store, self.adapter)
        self.engine.configure([G1, G2])

    def tearDown(self):
        self.store.close()

    def arrive(self, group=G2):
        self.adapter.rows[group['name']].append({**item('@小明 你好'), '_runtimeId': [1, 2], '_rect': [0, 10, 100, 70]})
        self.engine.poll()
        return self.store.pending()[-1]

    def payload(self, event, group=G2):
        return {'chatId': group['id'], 'bindingKey': group['bindingKey'], 'eventId': event['eventId']}

    def test_other_enabled_group_and_unrelated_append_still_resolve_once(self):
        event = self.arrive()
        self.adapter.rows[G2['name']].append(item('其他人继续说话'))
        self.engine.poll()
        result = self.engine.identity_reply(self.payload(event))
        self.assertEqual(result['status'], 'candidate')
        self.assertEqual(result['eventId'], event['eventId'])
        self.assertEqual(result['appearanceHash'], 'a' * 64)
        self.assertEqual(self.engine.identity_reply(self.payload(event)), result)
        self.assertEqual(self.adapter.probes, 1)
        self.assertEqual(event['botNickname'], '小明')

    def test_continuously_visible_target_can_move_but_changed_appearance_cannot(self):
        event = self.arrive()
        self.adapter.rows[G2['name']][-1]['_rect'] = [0, 40, 100, 100]
        self.engine.poll()
        self.assertEqual(self.engine.identity_reply(self.payload(event))['status'], 'candidate')
        event = self.arrive(G1)
        self.adapter.rows[G1['name']][-1]['_appearance'] = 'b' * 64
        self.assertEqual(self.engine.identity_reply(self.payload(event, G1))['status'], 'unknown')

    def test_disappeared_then_reused_runtime_is_never_rebound(self):
        event = self.arrive()
        self.adapter.rows[G2['name']] = [item('old')]
        self.engine.poll()
        self.arrive()
        self.assertEqual(self.engine.identity_reply(self.payload(event))['status'], 'unknown')
        self.assertEqual(self.adapter.probes, 0)

    def test_confirmed_self_echo_uses_server_event_id(self):
        self.engine.send({'commandId': 'send-one', 'chatId': G1['id'], 'bindingKey': G1['bindingKey'], 'text': '回复'})
        self.assertEqual(self.store.pending()[-1]['eventId'], 'sent-send-one')

    def test_snapshot_contains_no_body_and_expired_inbox_is_removed(self):
        event = self.arrive()
        self.assertNotIn('你好', str(self.store.snapshot(G2['id'])))
        self.store.enqueue({'eventId': 'expired', 'content': '旧正文', 'observedAt': (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()})
        self.assertEqual(self.store.expire_inbox(), 1)
        self.assertEqual([e['eventId'] for e in self.store.pending()], [event['eventId']])

    def test_only_confirmed_before_click_failure_retries_and_is_cached(self):
        for clicked, expected_calls in ((False, 2), (True, 1)):
            event = self.arrive()
            calls = []
            def probe(*args):
                calls.append(args)
                return {'status': 'unknown', 'reason': 'foreground', 'retryable': True, 'clicked': clicked}
            self.adapter.identity_message = probe
            result = self.engine.identity_reply(self.payload(event))
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(len(calls), expected_calls)
            self.engine.identity_reply(self.payload(event))
            self.assertEqual(len(calls), expected_calls)
            # Use another runtime so the following iteration has one unique target.
            self.adapter.rows[G2['name']][-1]['_runtimeId'] = [1, 10]

    def test_legacy_snapshot_is_fingerprinted_and_reconnect_does_not_replay_history(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = directory + '/legacy.sqlite'
            old = sqlite3.connect(filename)
            old.execute('CREATE TABLE snapshots(chat_id TEXT PRIMARY KEY,payload TEXT)')
            old.execute('INSERT INTO snapshots VALUES (?,?)', (G2['id'], json.dumps([item('old')])))
            old.commit()
            old.close()
            store = BridgeStore(filename)
            try:
                self.assertNotIn('old', str(store.snapshot(G2['id'])))
                engine = BridgeEngine(store, ReplyAdapter())
                engine.configure([G2])
                self.assertEqual(store.pending(), [])
            finally:
                store.close()

    def test_wrong_scope_and_reconfiguration_invalidate_cached_identity(self):
        event = self.arrive()
        self.assertEqual(self.engine.identity_reply(self.payload(event, G1))['status'], 'unknown')
        self.assertEqual(self.engine.identity_reply(self.payload(event))['status'], 'candidate')
        self.engine.configure([G1, G2])
        self.assertEqual(self.engine.identity_reply(self.payload(event))['status'], 'unknown')

    def test_expired_and_duplicate_runtime_never_click(self):
        event = self.arrive()
        self.engine.reply_identity_locations[event['eventId']]['at'] -= 121
        self.assertEqual(self.engine.identity_reply(self.payload(event))['status'], 'unknown')
        self.assertEqual(self.adapter.probes, 0)
        event = self.arrive(G1)
        self.adapter.rows[G1['name']].append({**item('另一个控件'), '_runtimeId': [1, 2], '_rect': [0, 80, 100, 150]})
        self.assertEqual(self.engine.identity_reply(self.payload(event, G1))['status'], 'unknown')
        self.assertEqual(self.adapter.probes, 0)
