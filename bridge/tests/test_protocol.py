import os
from unittest.mock import patch
import tempfile
import unittest
import base64
import hashlib
from pathlib import Path
from engine import BridgeEngine, binding_key
from store import BridgeStore
from transport import BridgeProtocol

TMP = Path(__file__).resolve().parents[2] / 'artifacts' / 'tmp'
TMP.mkdir(parents=True, exist_ok=True)
G1 = {
    'id': '1e97b930-fc17-4cc3-9b14-c87a1f509196',
    'name': '合成验收群',
    'bindingKey': binding_key('合成验收群'),
}
G2 = {
    'id': 'a39c4313-b4f3-4a09-b3d7-833db39319a9',
    'name': '另一个授权群',
    'bindingKey': binding_key('另一个授权群'),
}


def item(text):
    return {'kind': 'message', 'name': text, 'class': 'text'}


class FakeAdapter:
    connected = True

    def __init__(self):
        self.rows = {G1['name']: [item('old')], G2['name']: [item('old')]}
        self.sent = []

    def bind(self, name):
        return {'nickname': '小明'}

    def unbind_except(self, names):
        pass

    def read(self, name):
        return list(self.rows[name])

    def list_chats(self):
        return [{'name': x, 'bindingKey': binding_key(x)} for x in self.rows]

    def status(self):
        return {'connected': True, 'capabilities': {'receive': True, 'send': True}}

    def send(self, name, text):
        self.sent.append((name, text))
        self.rows[name].append(item(text))
        return {
            'status': 'sent',
            'detail': 'bubble confirmed',
            'snapshot': self.read(name),
            'selfIndices': [len(self.rows[name]) - 1],
        }

    def send_image(self, name, data):
        self.sent.append((name, data))
        return {'status': 'sent', 'detail': '图片已确认'}

    def identity_sample(self, name, avatar_hash):
        self.sent.append((name, avatar_hash))
        return {'status': 'candidate', 'name': '示例群友'}


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"WECHATBOT_TEST_GROUP": G1["name"]})
        env.start()
        self.addCleanup(env.stop)
        self.tmp = tempfile.TemporaryDirectory(dir=TMP)
        self.path = str(Path(self.tmp.name) / 'bridge.db')
        self.store = BridgeStore(self.path)
        self.adapter = FakeAdapter()
        self.engine = BridgeEngine(self.store, self.adapter)
        self.engine.configure([G1, G2])

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def command(self, **overrides):
        return {
            'commandId': 'command-1',
            'chatId': G1['id'],
            'bindingKey': G1['bindingKey'],
            'text': 'hello',
            **overrides,
        }

    def test_image_is_bound_to_group_and_hash_and_not_resent(self):
        raw = b'\x89PNG\r\n\x1a\nfixture'
        command = {
            'commandId': 'image-1',
            'chatId': G1['id'],
            'bindingKey': G1['bindingKey'],
            'data': base64.b64encode(raw).decode(),
            'sha256': hashlib.sha256(raw).hexdigest(),
        }
        self.assertEqual(self.engine.send_image(command)['status'], 'sent')
        self.assertEqual(self.engine.send_image(command)['status'], 'sent')
        self.assertEqual(len(self.adapter.sent), 1)
        self.assertEqual(
            self.engine.send_image({**command, 'bindingKey': G2['bindingKey']})['status'],
            'not_sent',
        )
        self.assertEqual(
            self.engine.send_image({**command, 'commandId': 'image-2', 'sha256': '0' * 64})[
                'status'
            ],
            'not_sent',
        )
        self.assertEqual(len(self.adapter.sent), 1)

    def test_identity_experiment_only_allows_specific_test_group_and_digest(self):
        payload = {
            'commandId': 'identity-test-1',
            'chatId': G1['id'],
            'bindingKey': G1['bindingKey'],
            'avatarHash': 'a' * 64,
        }
        self.assertEqual(self.engine.identity_sample(payload)['status'], 'candidate')
        self.assertEqual(self.engine.identity_sample(payload)['status'], 'unknown')
        self.assertEqual(
            self.engine.identity_sample(
                {**payload, 'chatId': G2['id'], 'bindingKey': G2['bindingKey']}
            )['status'],
            'unknown',
        )
        self.assertEqual(
            self.engine.identity_sample({**payload, 'avatarHash': 'broken'})['status'], 'unknown'
        )
        self.assertEqual(len(self.adapter.sent), 1)

    def test_diagnostic_capture_links_new_duplicate_events_without_persisting_ui_details(self):
        marker = '认人实时测试'
        digest = hashlib.sha256(marker.encode()).hexdigest()

        class IdentityAdapter(FakeAdapter):
            def identity_observations(self, name, chat_id, session_id, marker):
                return [
                    {
                        'chatId': chat_id,
                        'sessionId': session_id,
                        'runtimeId': row['_runtimeId'],
                        'rect': [0, i * 80, 100, i * 80 + 70],
                        'imageHash': ('a' if i == 1 else 'c') * 64,
                        'textHash': digest,
                        'visible': True,
                    }
                    for i, row in enumerate(self.rows[name])
                    if row.get('name') == marker
                ]

        adapter = IdentityAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1, G2])
        self.assertEqual(
            engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey']})['status'],
            'armed',
        )
        adapter.rows[G1['name']] += [
            {**item(marker), '_runtimeId': [1, 2], '_rect': [0, 80, 100, 150]},
            {**item(marker), '_runtimeId': [1, 3], '_rect': [0, 160, 100, 230]},
        ]
        engine.poll()
        events = [e for e in self.store.pending() if e['content'] == marker]
        self.assertEqual(len(events), 2)
        results = [
            engine.identity_status({'chatId': G1['id'], 'eventId': event['eventId']})
            for event in events
        ]
        self.assertEqual([result['status'] for result in results], ['current', 'current'])
        self.assertNotEqual(results[0]['avatarHash'], results[1]['avatarHash'])
        self.assertNotIn('_runtimeId', str(self.store.snapshot(G1['id'])))
        self.assertEqual(
            engine.identity_status({'chatId': G2['id'], 'eventId': events[0]['eventId']})['status'],
            'unknown',
        )
        engine.configure([G1, G2])
        self.assertEqual(
            engine.identity_status({'chatId': G1['id'], 'eventId': events[0]['eventId']})['status'],
            'unknown',
        )

    def test_runtime_id_recycling_does_not_replay_message(self):
        self.adapter.rows[G1['name']] = [{**item('old'), '_runtimeId': [1, 1]}]
        self.engine.poll()
        self.adapter.rows[G1['name']] = [{**item('old'), '_runtimeId': [9, 9]}]
        self.engine.poll()
        self.assertEqual(self.store.pending(), [])

    def test_name_capture_is_explicit_once_and_keeps_result_after_the_row_moves(self):
        marker = '认人实时测试'
        digest = hashlib.sha256(marker.encode()).hexdigest()

        class NameAdapter(FakeAdapter):
            def __init__(self):
                super().__init__()
                self.probes = 0

            def identity_observations(self, name, chat_id, session_id, marker):
                return [
                    {
                        'chatId': chat_id,
                        'sessionId': session_id,
                        'runtimeId': row['_runtimeId'],
                        'rect': row['_rect'],
                        'imageHash': 'a' * 64,
                        'textHash': digest,
                        'visible': True,
                    }
                    for row in self.rows[name]
                    if row.get('name') == marker
                ]

            def identity_name(self, name, chat_id, session_id, observation):
                self.probes += 1
                return {'status': 'candidate', 'name': '测试群友'}

        adapter = NameAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1])
        engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey'], 'readName': True})
        adapter.rows[G1['name']].append(
            {**item(marker), '_runtimeId': [1, 2], '_rect': [0, 80, 100, 150]}
        )
        engine.poll()
        event = self.store.pending()[-1]
        adapter.rows[G1['name']] = [item('最新消息')]
        result = engine.identity_status({'chatId': G1['id'], 'eventId': event['eventId']})
        self.assertEqual(
            result,
            {'status': 'candidate', 'name': '测试群友', 'identitySource': 'wechat-ui-profile'},
        )
        self.assertEqual(adapter.probes, 1)
        self.assertEqual(
            engine.identity_status({'chatId': G2['id'], 'eventId': event['eventId']})['status'],
            'unknown',
        )
        self.assertNotIn('测试群友', str(self.store.pending()))

    def test_duplicate_runtime_ids_do_not_bind_any_live_event(self):
        marker = '认人实时测试'
        digest = hashlib.sha256(marker.encode()).hexdigest()

        class IdentityAdapter(FakeAdapter):
            def identity_observations(self, name, chat_id, session_id, marker):
                return [
                    {
                        'chatId': chat_id,
                        'sessionId': session_id,
                        'runtimeId': row['_runtimeId'],
                        'rect': [0, i * 80, 100, i * 80 + 70],
                        'imageHash': ('a' if i == 1 else 'c') * 64,
                        'textHash': digest,
                        'visible': True,
                    }
                    for i, row in enumerate(self.rows[name])
                    if row.get('name') == marker
                ]

        adapter = IdentityAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1])
        engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey']})
        adapter.rows[G1['name']] += [
            {**item(marker), '_runtimeId': [1, 2]},
            {**item(marker), '_runtimeId': [1, 2]},
        ]
        engine.poll()
        events = [e for e in self.store.pending() if e['content'] == marker]
        self.assertEqual(len(events), 2)
        self.assertEqual(
            [
                engine.identity_status({'chatId': G1['id'], 'eventId': e['eventId']})['status']
                for e in events
            ],
            ['unknown', 'unknown'],
        )

    def test_missing_visual_row_cannot_alias_another_event_with_reused_runtime_id(self):
        marker = '认人实时测试'
        digest = hashlib.sha256(marker.encode()).hexdigest()

        class PartialAdapter(FakeAdapter):
            def identity_observations(self, name, chat_id, session_id, marker):
                return [
                    {
                        'chatId': chat_id,
                        'sessionId': session_id,
                        'runtimeId': [1, 2],
                        'rect': [0, 80, 100, 150],
                        'imageHash': 'a' * 64,
                        'textHash': digest,
                        'visible': True,
                    }
                ]

        adapter = PartialAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1])
        engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey']})
        adapter.rows[G1['name']] += [
            {**item(marker), '_runtimeId': [1, 2]},
            {**item(marker), '_runtimeId': [1, 2]},
        ]
        engine.poll()
        events = [e for e in self.store.pending() if e['content'] == marker]
        self.assertEqual(
            [
                engine.identity_status({'chatId': G1['id'], 'eventId': e['eventId']})['status']
                for e in events
            ],
            ['unknown', 'unknown'],
        )

    def test_capture_is_opt_in_and_failure_does_not_lose_messages(self):
        class FailingAdapter(FakeAdapter):
            def __init__(self):
                super().__init__()
                self.capture_calls = 0

            def identity_observations(self, *args):
                self.capture_calls += 1
                raise RuntimeError('capture failed')

        adapter = FailingAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1])
        adapter.rows[G1['name']].append({**item('认人实时测试'), '_runtimeId': [1, 1]})
        engine.poll()
        self.assertEqual(adapter.capture_calls, 0)
        self.assertEqual(len(self.store.pending()), 1)
        engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey']})
        adapter.rows[G1['name']].append({**item('认人实时测试'), '_runtimeId': [1, 2]})
        engine.poll()
        self.assertEqual(adapter.capture_calls, 1)
        self.assertEqual(len(self.store.pending()), 2)
        event = self.store.pending()[-1]
        result = engine.identity_status({'chatId': G1['id'], 'eventId': event['eventId']})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result.get('reason'), 'capture_error')

    def test_capture_rejects_source_rectangle_changed_before_screenshot(self):
        marker = '认人实时测试'
        digest = hashlib.sha256(marker.encode()).hexdigest()

        class MovedAdapter(FakeAdapter):
            def identity_observations(self, name, chat_id, session_id, marker):
                return [
                    {
                        'chatId': chat_id,
                        'sessionId': session_id,
                        'runtimeId': [1, 2],
                        'rect': [0, 99, 100, 169],
                        'imageHash': 'a' * 64,
                        'textHash': digest,
                        'visible': True,
                    }
                ]

        adapter = MovedAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1])
        engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey']})
        adapter.rows[G1['name']].append(
            {**item(marker), '_runtimeId': [1, 2], '_rect': [0, 80, 100, 150]}
        )
        engine.poll()
        event = self.store.pending()[-1]
        result = engine.identity_status({'chatId': G1['id'], 'eventId': event['eventId']})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result.get('reason'), 'event_evidence_missing')

    def test_capture_rejects_when_message_list_changes_during_observation(self):
        marker = '认人实时测试'
        digest = hashlib.sha256(marker.encode()).hexdigest()

        class ChangingAdapter(FakeAdapter):
            def identity_observations(self, name, chat_id, session_id, marker):
                self.rows[name].append(item('窗口变化'))
                return [
                    {
                        'chatId': chat_id,
                        'sessionId': session_id,
                        'runtimeId': [1, 2],
                        'rect': [0, 80, 100, 150],
                        'imageHash': 'a' * 64,
                        'textHash': digest,
                        'visible': True,
                    }
                ]

        adapter = ChangingAdapter()
        engine = BridgeEngine(self.store, adapter)
        engine.configure([G1])
        engine.identity_arm({'chatId': G1['id'], 'bindingKey': G1['bindingKey']})
        adapter.rows[G1['name']].append(
            {**item(marker), '_runtimeId': [1, 2], '_rect': [0, 80, 100, 150]}
        )
        engine.poll()
        event = self.store.pending()[-1]
        result = engine.identity_status({'chatId': G1['id'], 'eventId': event['eventId']})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result.get('reason'), 'snapshot_changed')

    def test_real_repeated_text_preserved_and_replayed_until_ack(self):
        self.adapter.rows[G1['name']] += [item('你好'), item('你好')]
        self.engine.poll()
        events = self.store.pending()
        self.assertEqual([x['content'] for x in events], ['你好', '你好'])
        self.assertNotEqual(events[0]['eventId'], events[1]['eventId'])
        self.assertTrue(all(x['senderId'] is None and x['senderName'] is None for x in events))
        protocol = BridgeProtocol(self.store, lambda x: None)
        first = protocol.replay()
        self.assertEqual(first, protocol.replay())
        protocol.receive({'type': 'nack', 'eventId': events[0]['eventId']})
        self.assertEqual(len(protocol.replay()), 2)
        protocol.receive({'type': 'ack', 'eventId': events[0]['eventId']})
        self.assertEqual(protocol.replay(), [first[1]])
        self.store.close()
        self.store = BridgeStore(self.path)
        self.assertEqual(self.store.pending()[0]['eventId'], events[1]['eventId'])

    def test_send_routes_exact_chat_and_executes_id_only_once(self):
        first = self.engine.send(self.command())
        self.assertEqual(first['status'], 'sent')
        self.assertEqual(self.engine.send(self.command())['status'], 'sent')
        self.assertEqual(self.adapter.sent, [(G1['name'], 'hello')])
        result = self.engine.send(self.command(commandId='c2', bindingKey=G2['bindingKey']))
        self.assertEqual(result['status'], 'not_sent')
        self.assertEqual(len(self.adapter.sent), 1)
        result = self.engine.send(self.command(chatId=G2['id'], bindingKey=G2['bindingKey']))
        self.assertEqual(result['status'], 'not_sent')
        self.assertEqual(len(self.adapter.sent), 1)

    def test_only_confirmed_outgoing_occurrence_is_self(self):
        self.engine.send(self.command(text='same'))
        self.adapter.rows[G1['name']].append(item('same'))
        self.engine.poll()
        self.assertEqual(
            [(e['content'], e['isSelf']) for e in self.store.pending()],
            [('same', True), ('same', False)],
        )

    def test_ui_exception_is_unknown_never_retried(self):
        def fail(*args):
            raise RuntimeError('after possible Enter')

        self.adapter.send = fail
        self.assertEqual(self.engine.send(self.command())['status'], 'unknown')
        self.assertEqual(self.engine.send(self.command())['status'], 'unknown')

    def test_confirmed_not_sent_retries_same_id_then_replays_sent_without_ui(self):
        calls = []
        recovered_send = self.adapter.send

        def initially_blocked(name, text):
            calls.append((name, text))
            if len(calls) == 1:
                return {'status': 'not_sent', 'detail': 'existing draft; Enter not pressed'}
            return recovered_send(name, text)

        self.adapter.send = initially_blocked
        self.assertEqual(self.engine.send(self.command())['status'], 'not_sent')
        self.assertEqual(calls, [(G1['name'], 'hello')])
        self.assertEqual(self.adapter.sent, [])
        self.assertEqual(self.engine.send(self.command())['status'], 'sent')
        self.assertEqual(self.engine.send(self.command())['status'], 'sent')
        self.assertEqual(calls, [(G1['name'], 'hello'), (G1['name'], 'hello')])
        self.assertEqual(self.adapter.sent, [(G1['name'], 'hello')])

    def test_unknown_and_executing_never_retry_ui_even_if_adapter_recovers(self):
        for status in ('unknown', 'executing'):
            with self.subTest(status=status):
                command = self.command(commandId='blocked-' + status)
                calls = []

                def uncertain(name, text):
                    calls.append((name, text))
                    return {'status': 'unknown', 'detail': 'cannot confirm Enter result'}

                self.adapter.send = uncertain
                self.assertEqual(self.engine.send(command)['status'], 'unknown')
                self.store.finish_send(command['commandId'], status, 'outcome not confirmed')
                self.adapter.send = lambda name, text: calls.append(('unsafe retry', text)) or {
                    'status': 'sent'
                }
                self.assertEqual(self.engine.send(command)['status'], 'unknown')
                self.assertEqual(calls, [(G1['name'], 'hello')])

    def test_duplicate_configuration_rejected_before_ui_binding(self):
        with self.assertRaises(ValueError):
            self.engine.configure([G1, {**G1, 'id': G2['id']}])
        self.assertEqual(len(self.engine.chats), 2)

    def test_gap_diagnostic_and_no_history_replay(self):
        self.adapter.rows[G1['name']] = [item('totally different old history')]
        diagnostics = self.engine.poll()
        self.assertTrue(any('缺口' in x for x in diagnostics))
        self.assertEqual(self.store.pending(), [])
        self.assertIn(G1['id'], self.engine.status()['diagnostics']['snapshotGaps'])

    def test_reconnect_gap_is_visible_in_status(self):
        self.adapter.rows[G1['name']] = [item('unresolvable new window')]
        state = self.engine.configure([G1, G2])
        self.assertIn(G1['id'], state['diagnostics']['snapshotGaps'])
        self.assertEqual(self.store.pending(), [])

    def test_protocol_does_not_execute_uia_on_network_thread(self):
        commands = []
        protocol = BridgeProtocol(self.store, commands.append)
        request = {'type': 'request', 'requestId': 'r', 'action': 'send', 'payload': self.command()}
        protocol.receive(request)
        self.assertEqual(commands, [request])
        self.assertEqual(self.adapter.sent, [])

    def test_snapshot_and_inbox_commit_together(self):
        def bad_event():
            yield {'eventId': 'once', 'content': 'ok'}
            raise RuntimeError('simulated transaction failure')

        with self.assertRaises(RuntimeError):
            self.store.commit_observation('new', [item('a')], bad_event())
        self.assertEqual(self.store.snapshot('new'), [])
        self.assertEqual(self.store.pending(), [])

    def test_first_arrival_in_an_empty_bound_group_is_not_lost(self):
        self.adapter.rows[G1['name']] = []
        self.store.save_snapshot(G1['id'], [])
        self.adapter.rows[G1['name']] = [item('@小明\u2005你好'), item('@小明明你好')]
        self.engine.poll()
        self.assertEqual([e['mentioned'] for e in self.store.pending()], [True, False])


if __name__ == '__main__':
    unittest.main()
