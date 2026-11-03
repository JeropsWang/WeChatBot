import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace
from chat_image_capture import picture_rect, picture_pixels
from PIL import Image, ImageDraw
from engine import BridgeEngine
from store import BridgeStore
from test_protocol import FakeAdapter, G1
from transport import BridgeProtocol
from wx_adapter import WxAdapter


class BatchImageAdapter(FakeAdapter):
    def __init__(self):
        super().__init__()
        self.actions = []
        self.probed = False
        self.changed_avatar = False

    def read(self, name):
        return __import__('copy').deepcopy(self.rows[name])

    def capture_image(self, name, runtime, rect):
        self.actions.append(('capture', runtime[-1]))
        if self.probed:
            return {'status': 'unavailable', 'reason': '图片行不完整'}
        return {
            'status': 'ready',
            'mimeType': 'image/png',
            'width': 100,
            'height': 100,
            'sha256': 'a' * 64,
            'quality': 'thumbnail',
            'data': 'frame-' + str(runtime[-1]),
            'avatarHash': 'b' * 64,
        }

    def identity_message_observation(self, name, chat_id, session_id, text, runtime):
        row = next((r for r in self.rows[name] if r.get('_runtimeId') == runtime), None)
        if not row:
            return None
        return {
            'chatId': chat_id,
            'sessionId': session_id,
            'runtimeId': runtime,
            'rect': list(row['_rect']),
            'imageHash': ('c' if self.changed_avatar else 'b') * 64,
            'textHash': __import__('hashlib').sha256(text.encode()).hexdigest(),
            'visible': True,
        }

    def identity_message(self, name, chat_id, session_id, text, runtime, rect, expected):
        self.probed = True
        self.actions.append(('probe', runtime[-1]))
        row = next(r for r in self.rows[name] if r.get('_runtimeId') == runtime)
        if rect != row['_rect'] or expected['rect'] != rect:
            return {'status': 'unknown'}
        self.actions.append(('profile', runtime[-1], list(rect)))
        return {'status': 'candidate', 'name': '作者' + str(runtime[-1])}


class ChatImageCaptureTests(unittest.TestCase):
    def test_failed_profile_probe_keeps_the_picture_and_reports_the_exact_reason(self):
        class NoName(BatchImageAdapter):
            def identity_message(self, *args):
                return {
                    'status': 'unknown',
                    'reason': '未读取到唯一名称',
                    'reasonCode': 'name_unavailable',
                    'clicked': True,
                }

        store = BridgeStore(':memory:')
        try:
            adapter = NoName()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 100, 300, 200],
                }
            )
            engine.poll()
            event = store.pending()[0]
            self.assertEqual(event['image']['status'], 'pending')
            self.assertEqual(event['uiIdentityFailure']['reasonCode'], 'name_unavailable')
            self.assertEqual(event['uiIdentityFailure']['reason'], '未读取到唯一名称')
        finally:
            store.close()

    def test_successful_frame_omits_absent_reason_in_wire_event(self):
        store = BridgeStore(':memory:')
        try:
            adapter = BatchImageAdapter()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 100, 300, 200],
                }
            )
            engine.poll()
            self.assertNotIn('reason', store.pending()[0]['image'])
        finally:
            store.close()

    def test_disappeared_reused_or_changed_visual_row_never_opens_profile(self):
        for mutation in (
            'offscreen',
            'reused-as-text',
            'changed-marker',
            'duplicate-runtime',
            'moved-without-avatar-hash',
        ):
            with self.subTest(mutation=mutation):

                class Changed(BatchImageAdapter):
                    def capture_image(self, name, runtime, rect):
                        result = super().capture_image(name, runtime, rect)
                        row = next(r for r in self.rows[name] if r.get('_runtimeId') == runtime)
                        if mutation == 'offscreen':
                            self.rows[name].remove(row)
                        elif mutation == 'reused-as-text':
                            row.update(kind='message', **{'class': 'mmui::ChatTextItemView'})
                        elif mutation == 'changed-marker':
                            row['name'] = '[动画表情]'
                        elif mutation == 'duplicate-runtime':
                            self.rows[name].append(dict(row))
                        else:
                            row['_rect'] = [0, 20, 300, 120]
                            result.pop('avatarHash')
                        return result

                store = BridgeStore(':memory:')
                try:
                    adapter = Changed()
                    engine = BridgeEngine(store, adapter)
                    engine.configure([G1])
                    adapter.rows[G1['name']].append(
                        {
                            'kind': 'image',
                            'name': '[图片]',
                            'class': 'mmui::ChatImageItemView',
                            '_runtimeId': [5, 1],
                            '_rect': [0, 100, 300, 200],
                        }
                    )
                    engine.poll()
                    self.assertEqual(adapter.actions, [('capture', 1)])
                    self.assertNotIn('uiCandidate', store.pending()[0])
                    self.assertEqual(store.pending()[0]['image']['status'], 'pending')
                    self.assertEqual(len(store.pending_image_uploads()), 1)
                finally:
                    store.close()

    def test_profile_exception_does_not_downgrade_successfully_captured_frame(self):
        class BrokenProfile(BatchImageAdapter):
            def identity_message(self, *args):
                raise RuntimeError('profile disappeared')

        store = BridgeStore(':memory:')
        try:
            adapter = BrokenProfile()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 100, 300, 200],
                }
            )
            engine.poll()
            self.assertNotIn('uiCandidate', store.pending()[0])
            self.assertEqual(store.pending()[0]['image']['status'], 'pending')
            self.assertEqual(len(store.pending_image_uploads()), 1)
        finally:
            store.close()

    def test_all_new_images_are_captured_before_first_profile_probe(self):
        store = BridgeStore(':memory:')
        try:
            adapter = BatchImageAdapter()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            for i in (1, 2):
                adapter.rows[G1['name']].append(
                    {
                        'kind': 'image',
                        'name': '[图片]',
                        'class': 'mmui::ChatImageItemView',
                        '_runtimeId': [5, i],
                        '_rect': [0, i * 100, 300, i * 100 + 100],
                    }
                )
            engine.poll()
            self.assertEqual(adapter.actions[:2], [('capture', 1), ('capture', 2)])
            self.assertEqual(
                [e['uiCandidate']['name'] for e in store.pending()], ['作者1', '作者2']
            )
            self.assertEqual(
                [u['data'] for u in store.pending_image_uploads()], ['frame-1', 'frame-2']
            )
        finally:
            store.close()

    def test_same_avatar_and_runtime_move_uses_current_rectangle_for_profile(self):
        class Moving(BatchImageAdapter):
            def capture_image(self, name, runtime, rect):
                result = super().capture_image(name, runtime, rect)
                row = next(r for r in self.rows[name] if r.get('_runtimeId') == runtime)
                row['_rect'] = [0, 20, 300, 120]
                return result

        store = BridgeStore(':memory:')
        try:
            adapter = Moving()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 100, 300, 200],
                }
            )
            engine.poll()
            self.assertEqual(store.pending()[0].get('uiCandidate', {}).get('name'), '作者1')
            self.assertIn(('profile', 1, [0, 20, 300, 120]), adapter.actions)
        finally:
            store.close()

    def test_changed_avatar_after_capture_never_opens_profile_and_keeps_frame(self):
        store = BridgeStore(':memory:')
        try:
            adapter = BatchImageAdapter()
            adapter.changed_avatar = True
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 100, 300, 200],
                }
            )
            engine.poll()
            self.assertEqual(adapter.actions, [('capture', 1)])
            self.assertNotIn('uiCandidate', store.pending()[0])
            self.assertEqual(store.pending()[0]['image']['status'], 'pending')
            self.assertEqual(len(store.pending_image_uploads()), 1)
        finally:
            store.close()

    def test_right_edge_avatar_marks_self_and_never_uploads_or_probes_identity(self):
        class SelfImage(FakeAdapter):
            def capture_image(self, *args):
                return {
                    'status': 'unavailable',
                    'isSelf': True,
                    'reason': '右侧本人头像已确认，跳过自发图片',
                }

            def identity_message_observation(self, *args):
                raise AssertionError('self must not be probed')

        store = BridgeStore(':memory:')
        try:
            adapter = SelfImage()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 0, 895, 270],
                }
            )
            engine.poll()
            self.assertTrue(store.pending()[0]['isSelf'])
            self.assertIn('本人', store.pending()[0]['image']['reason'])
            self.assertEqual(store.pending_image_uploads(), [])
        finally:
            store.close()

    def test_deferred_batch_does_not_claim_image_capture_capability(self):
        class Partial(FakeAdapter):
            def capture_image(self, name, runtime, rect):
                if runtime[-1] == 2:
                    return {'status': 'unavailable', 'reason': '图片行不完整'}
                return {
                    'status': 'ready',
                    'mimeType': 'image/png',
                    'width': 100,
                    'height': 100,
                    'sha256': 'a' * 64,
                    'quality': 'thumbnail',
                    'data': 'fixture',
                }

        store = BridgeStore(':memory:')
        try:
            adapter = Partial()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            for i in (1, 2):
                adapter.rows[G1['name']].append(
                    {
                        'kind': 'image',
                        'name': '[图片]',
                        'class': 'mmui::ChatImageItemView',
                        '_runtimeId': [5, i],
                        '_rect': [0, 0, 300, 250],
                    }
                )
            engine.poll()
            self.assertEqual(store.pending_image_uploads(), [])
            self.assertFalse(engine.status()['capabilities']['receiveImages'])
        finally:
            store.close()

    def test_only_unique_outer_right_avatar_is_self_evidence(self):
        import chat_image_capture

        row = Image.new('RGB', (895, 270), (38, 38, 38))
        draw = ImageDraw.Draw(row)
        draw.rectangle((811, 13, 864, 66), fill=(180, 80, 210))
        draw.rectangle((220, 40, 680, 240), fill=(220, 200, 170))
        draw.rectangle((240, 60, 293, 113), fill=(100, 90, 40))
        self.assertTrue(chat_image_capture.self_authored_row(row))
        draw.rectangle((811, 13, 864, 66), fill=(38, 38, 38))
        self.assertFalse(chat_image_capture.self_authored_row(row))

    def test_native_animation_placeholder_is_one_visual_event_not_quoted_text(self):
        rect = SimpleNamespace(left=0, top=10, right=897, bottom=269)
        control = SimpleNamespace(
            ClassName='mmui::ChatBubbleReferItemView',
            Name='动画表情',
            BoundingRectangle=rect,
            GetRuntimeId=lambda: [9, 1],
        )
        listened = SimpleNamespace(
            kind='message',
            name='动画表情',
            class_name=control.ClassName,
            runtime_id=(9, 1),
            control=control,
        )
        adapter = WxAdapter()
        with patch.object(
            adapter,
            '_session',
            return_value=SimpleNamespace(msg_list=SimpleNamespace(GetChildren=lambda: [control])),
        ), patch('wx4py.features.messaging.listener._read_visible_items', return_value=[listened]):
            rows = adapter.read('测试群')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['kind'], 'image')
        self.assertEqual(rows[0]['name'], '[动画表情]')
        self.assertNotIn('unresolvedQuote', rows[0])

    def test_literal_animation_text_does_not_become_an_image(self):
        rect = SimpleNamespace(left=0, top=0, right=897, bottom=80)
        control = SimpleNamespace(
            ClassName='mmui::ChatTextItemView',
            Name='动画表情',
            BoundingRectangle=rect,
            GetRuntimeId=lambda: [9, 2],
        )
        listened = SimpleNamespace(
            kind='message',
            name='动画表情',
            class_name=control.ClassName,
            runtime_id=(9, 2),
            control=control,
        )
        adapter = WxAdapter()
        with patch.object(
            adapter,
            '_session',
            return_value=SimpleNamespace(msg_list=SimpleNamespace(GetChildren=lambda: [control])),
        ), patch('wx4py.features.messaging.listener._read_visible_items', return_value=[listened]):
            rows = adapter.read('测试群')
        self.assertEqual(rows[0]['kind'], 'message')

    def test_visual_identity_marker_requires_the_animation_row_class(self):
        from visual_messages import matches_visual_marker

        self.assertTrue(
            matches_visual_marker('mmui::ChatBubbleReferItemView', '动画表情', '[动画表情]')
        )
        self.assertFalse(
            matches_visual_marker('mmui::ChatBubbleReferItemView', '引用文字', '[动画表情]')
        )
        self.assertFalse(matches_visual_marker('mmui::ChatTextItemView', '动画表情', '[动画表情]'))
        self.assertFalse(
            matches_visual_marker('mmui::ChatBubbleReferItemView', '动画表情', '[图片]')
        )

    def test_animation_uses_its_own_marker_for_identity_and_does_not_replay_frames(self):
        class Animation(FakeAdapter):
            def capture_image(self, name, runtime, rect):
                return {
                    'status': 'ready',
                    'mimeType': 'image/png',
                    'width': 100,
                    'height': 100,
                    'sha256': 'a' * 64,
                    'quality': 'thumbnail',
                    'data': 'frame-bytes',
                    'avatarHash': 'b' * 64,
                }

            def identity_message_observation(self, name, chat_id, session_id, text, runtime):
                return {
                    'chatId': chat_id,
                    'sessionId': session_id,
                    'runtimeId': runtime,
                    'rect': [0, 0, 897, 259],
                    'imageHash': 'b' * 64,
                    'textHash': __import__('hashlib').sha256(text.encode()).hexdigest(),
                    'visible': True,
                }

            def identity_message(self, name, chat_id, session_id, text, runtime, rect, expected):
                return (
                    {'status': 'candidate', 'name': '动画作者'}
                    if text == '[动画表情]'
                    else {'status': 'unknown'}
                )

        store = BridgeStore(':memory:')
        try:
            adapter = Animation()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[动画表情]',
                    'class': 'mmui::ChatBubbleReferItemView',
                    '_runtimeId': [9, 1],
                    '_rect': [0, 0, 897, 259],
                }
            )
            engine.poll()
            events = store.pending()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]['type'], 'image')
            self.assertEqual(events[0]['uiCandidate']['name'], '动画作者')
            engine.poll()
            self.assertEqual(store.pending(), events)
            self.assertEqual(len(store.pending_image_uploads()), 1)
        finally:
            store.close()

    def test_captured_frame_is_not_assigned_to_a_reused_rows_different_avatar(self):
        class Reused(FakeAdapter):
            def capture_image(self, name, runtime, rect):
                return {
                    'status': 'ready',
                    'mimeType': 'image/png',
                    'width': 100,
                    'height': 100,
                    'sha256': 'a' * 64,
                    'quality': 'thumbnail',
                    'data': 'frame-bytes',
                    'avatarHash': 'b' * 64,
                }

            def identity_message_observation(self, name, chat_id, session_id, text, runtime):
                return {
                    'chatId': chat_id,
                    'sessionId': session_id,
                    'runtimeId': runtime,
                    'rect': [0, 0, 897, 259],
                    'imageHash': 'c' * 64,
                    'textHash': __import__('hashlib').sha256(text.encode()).hexdigest(),
                    'visible': True,
                }

            def identity_message(self, *args):
                raise AssertionError('Must not click another avatar')

        store = BridgeStore(':memory:')
        try:
            adapter = Reused()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[动画表情]',
                    'class': 'mmui::ChatBubbleReferItemView',
                    '_runtimeId': [9, 1],
                    '_rect': [0, 0, 897, 259],
                }
            )
            engine.poll()
            self.assertNotIn('uiCandidate', store.pending()[0])
            self.assertEqual(len(store.pending_image_uploads()), 1)
        finally:
            store.close()

    def test_full_window_identical_animations_require_a_continuing_row_and_new_runtime(self):
        import hashlib

        def rows(*ids):
            return [
                {
                    'kind': 'image',
                    'name': '[动画表情]',
                    'class': 'mmui::ChatBubbleReferItemView',
                    '_runtimeId': [10, i],
                    '_rect': [0, n * 259, 897, (n + 1) * 259],
                }
                for n, i in enumerate(ids)
            ]

        class AnimatedWindow(FakeAdapter):
            def capture_image(self, name, runtime, rect):
                return {
                    'status': 'ready',
                    'mimeType': 'image/png',
                    'width': 100,
                    'height': 100,
                    'sha256': 'a' * 64,
                    'quality': 'thumbnail',
                    'data': 'frame',
                    'avatarHash': 'b' * 64,
                }

            def identity_message_observation(self, name, chat_id, session_id, text, runtime):
                row = next((r for r in self.rows[name] if r.get('_runtimeId') == runtime), None)
                if not row:
                    return None
                return {
                    'chatId': chat_id,
                    'sessionId': session_id,
                    'runtimeId': runtime,
                    'rect': row['_rect'],
                    'imageHash': 'b' * 64,
                    'textHash': hashlib.sha256(text.encode()).hexdigest(),
                    'visible': True,
                }

            def identity_message(self, *args):
                return {'status': 'candidate', 'name': '动画作者'}

        for new_ids, expected in [((2, 3), 1), ((2, 1), 0), ((3, 4), 0)]:
            with self.subTest(new_ids=new_ids):
                store = BridgeStore(':memory:')
                try:
                    adapter = AnimatedWindow()
                    adapter.rows[G1['name']] = rows(1, 2)
                    engine = BridgeEngine(store, adapter)
                    engine.configure([G1])
                    self.assertEqual(store.pending(), [])
                    adapter.rows[G1['name']] = rows(*new_ids)
                    engine.poll()
                    self.assertEqual(len(store.pending()), expected)
                    engine.poll()
                    self.assertEqual(len(store.pending()), expected)
                    engine.configure([G1])
                    self.assertEqual(len(store.pending()), expected)
                finally:
                    store.close()

    def test_continually_moving_image_times_out_without_blocking_following_text(self):
        class Moving(FakeAdapter):
            def capture_image(self, name, runtime, rect):
                return {'status': 'unavailable', 'reason': '截图期间图片气泡变化'}

        store = BridgeStore(':memory:')
        clock = [0]
        try:
            adapter = Moving()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']] += [
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 0, 300, 250],
                },
                {'kind': 'message', 'name': '后续文字', 'class': 'text'},
            ]
            with patch('engine.time.monotonic', side_effect=lambda: clock[0]):
                engine.poll()
                self.assertEqual(store.pending(), [])
                clock[0] = 5.1
                engine.poll()
            self.assertEqual([e['type'] for e in store.pending()], ['image', 'text'])
            self.assertEqual(store.pending()[0]['image']['status'], 'unavailable')
        finally:
            store.close()

    def test_new_image_background_window_is_activated_before_fresh_observation(self):
        adapter = WxAdapter()
        session = SimpleNamespace(hwnd=123, root=Mock())
        with patch.object(adapter, '_session', return_value=session), patch(
            'win32gui.IsIconic', return_value=False
        ), patch('win32gui.GetForegroundWindow', side_effect=[456, 123]), patch(
            'identity_sample_driver.SampleDriver'
        ) as factory, patch(
            'identity_focus.ensure_foreground', return_value=True
        ) as focus, patch(
            'wx_adapter.time.sleep'
        ):
            factory.return_value.has_draft.return_value = False
            factory.return_value.has_profile_popup.return_value = False
            self.assertTrue(adapter.prepare_image_capture('群'))
            self.assertFalse(adapter.prepare_image_capture('群'))
            focus.assert_called_once_with(123)

    def test_unpainted_new_image_is_retried_before_committing_unavailable(self):
        class Loading(FakeAdapter):
            calls = 0

            def capture_image(self, name, runtime, rect):
                self.calls += 1
                if self.calls == 1:
                    return {'status': 'unavailable', 'reason': '无法安全区分图片区域与头像/文字'}
                return {
                    'status': 'ready',
                    'mimeType': 'image/png',
                    'width': 100,
                    'height': 100,
                    'sha256': 'a' * 64,
                    'quality': 'thumbnail',
                    'data': 'bytes',
                }

        store = BridgeStore(':memory:')
        try:
            adapter = Loading()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append(
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 0, 300, 250],
                }
            )
            engine.poll()
            self.assertEqual(store.pending(), [])
            engine.poll()
            self.assertEqual(store.pending()[0]['image']['status'], 'pending')
            self.assertEqual(len(store.pending_image_uploads()), 1)
        finally:
            store.close()

    def test_unread_navigation_preserves_drafts_and_never_reclicks_the_same_bar(self):
        adapter = WxAdapter()
        session = SimpleNamespace(hwnd=123, root=Mock())
        button = Mock()
        button.ClassName = 'mmui::UnreadBarView'
        button.ControlTypeName = 'ButtonControl'
        button.Name = '3条新消息'
        button.GetRuntimeId.return_value = [1, 2]
        with patch.object(adapter, '_session', return_value=session), patch(
            'wx4py.core.uiautomation.WalkControl', return_value=[(button, 1)]
        ), patch('identity_sample_driver.SampleDriver') as factory, patch(
            'win32gui.IsIconic', return_value=False
        ), patch(
            'identity_focus.ensure_foreground', return_value=True
        ):
            driver = factory.return_value
            driver.has_draft.return_value = True
            driver.has_profile_popup.return_value = False
            self.assertFalse(adapter.prepare_listener_view('群'))
            button.Click.assert_not_called()
            driver.has_draft.return_value = False
            self.assertTrue(adapter.prepare_listener_view('群'))
            self.assertFalse(adapter.prepare_listener_view('群'))
            button.Click.assert_called_once_with(simulateMove=False)

    def test_unread_navigation_defers_poll_without_advancing_the_cursor(self):
        class Navigate(FakeAdapter):
            calls = 0

            def prepare_listener_view(self, name):
                self.calls += 1
                return self.calls == 1

        store = BridgeStore(':memory:')
        try:
            adapter = Navigate()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']].append({'kind': 'message', 'name': '新文字', 'class': 'text'})
            before = store.snapshot(G1['id'])
            engine.poll()
            self.assertEqual(store.pending(), [])
            self.assertEqual(store.snapshot(G1['id']), before)
            engine.poll()
            self.assertEqual([e['content'] for e in store.pending()], ['新文字'])
        finally:
            store.close()

    def test_minimized_new_image_defers_entire_batch_until_fresh_observation(self):
        class Restore(FakeAdapter):
            calls = 0

            def prepare_image_capture(self, name):
                self.calls += 1
                return self.calls == 1

        store = BridgeStore(':memory:')
        try:
            adapter = Restore()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            adapter.rows[G1['name']] += [
                {
                    'kind': 'image',
                    'name': '[图片]',
                    'class': 'mmui::ChatImageItemView',
                    '_runtimeId': [5, 1],
                    '_rect': [0, 0, 300, 250],
                },
                {'kind': 'message', 'name': '识图', 'class': 'text'},
            ]
            previous = store.snapshot(G1['id'])
            engine.poll()
            self.assertEqual(store.pending(), [])
            self.assertEqual(store.snapshot(G1['id']), previous)
            engine.poll()
            self.assertEqual([x['type'] for x in store.pending()], ['image', 'text'])
        finally:
            store.close()

    def test_pixel_picture_boundary_excludes_avatar_and_name_when_uia_has_only_row(self):
        row = Image.new('RGB', (895, 270), (38, 38, 38))
        draw = ImageDraw.Draw(row)
        draw.rectangle((31, 13, 84, 66), fill=(180, 80, 210))
        draw.text((106, 18), 'Outroller', fill=(160, 160, 160))
        draw.rectangle((106, 44, 474, 250), fill=(220, 200, 170))
        self.assertEqual(picture_pixels(row), (106, 44, 475, 251))
        draw.rectangle((106, 44, 474, 250), fill=(38, 38, 38))
        self.assertIsNone(picture_pixels(row))

    def test_native_reference_rows_are_kept_even_when_dependency_filters_them(self):
        rect = SimpleNamespace(left=0, top=10, right=300, bottom=150)
        quote = SimpleNamespace(
            ClassName='mmui::ChatBubbleReferItemView',
            Name='@小明 看看这张图',
            BoundingRectangle=rect,
            GetRuntimeId=lambda: [8, 1],
        )
        adapter = WxAdapter()
        with patch.object(
            adapter,
            '_session',
            return_value=SimpleNamespace(msg_list=SimpleNamespace(GetChildren=lambda: [quote])),
        ), patch('wx4py.features.messaging.listener._read_visible_items', return_value=[]):
            rows = adapter.read('测试群')
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['unresolvedQuote'])
        self.assertEqual(rows[0]['name'], '@小明 看看这张图')

    def test_requires_unique_image_child_and_excludes_avatar_and_outside_viewport(self):
        image = {
            'type': 'ImageControl',
            'class': 'Image',
            'id': 'picture',
            'rect': [70, 20, 220, 170],
        }
        avatar = {'type': 'ImageControl', 'class': 'Image', 'id': 'avatar', 'rect': [5, 20, 65, 90]}
        self.assertEqual(
            picture_rect([avatar, image], [0, 0, 300, 200], [0, 0, 300, 200]), image['rect']
        )
        self.assertIsNone(picture_rect([image], [0, 0, 300, 200], [0, 40, 300, 200]))
        self.assertIsNone(
            picture_rect(
                [image, {**image, 'rect': [80, 30, 230, 180]}], [0, 0, 300, 200], [0, 0, 300, 200]
            )
        )
        self.assertIsNone(picture_rect([avatar], [0, 0, 300, 200], [0, 0, 300, 200]))
        self.assertIsNone(picture_rect([{**image, 'id': ''}], [0, 0, 300, 200], [0, 0, 300, 200]))

    def test_image_occurrences_keep_individual_ids_and_bytes_out_of_events(self):
        class Images(FakeAdapter):
            def capture_image(self, name, runtime, rect):
                return {
                    'status': 'ready',
                    'mimeType': 'image/png',
                    'width': 100,
                    'height': 100,
                    'sha256': 'a' * 64,
                    'quality': 'thumbnail',
                    'data': 'same-bytes',
                }

        store = BridgeStore(':memory:')
        try:
            adapter = Images()
            engine = BridgeEngine(store, adapter)
            engine.configure([G1])
            for n in (1, 2):
                adapter.rows[G1['name']].append(
                    {
                        'kind': 'image',
                        'name': '[图片]',
                        'class': 'mmui::ChatImageItemView',
                        '_runtimeId': [1, n],
                        '_rect': [0, n * 100, 200, n * 100 + 100],
                    }
                )
            engine.poll()
            events = store.pending()
            self.assertEqual(len(events), 2)
            self.assertTrue(all(e['type'] == 'image' for e in events))
            self.assertNotEqual(events[0]['eventId'], events[1]['eventId'])
            self.assertNotEqual(
                events[0]['image']['attachmentId'], events[1]['image']['attachmentId']
            )
            self.assertEqual(len(store.pending_image_uploads()), 2)
            self.assertNotIn('same-bytes', str(BridgeProtocol(store, lambda _: None).replay()))
            engine.poll()
            self.assertEqual(store.pending(), events)
        finally:
            store.close()
