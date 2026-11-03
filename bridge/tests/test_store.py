import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from store import BridgeStore, reconcile

TEST_TMP = Path(__file__).resolve().parents[2] / 'artifacts' / 'tmp'
TEST_TMP.mkdir(parents=True, exist_ok=True)


class BridgeStoreTests(unittest.TestCase):
    def test_identical_messages_are_distinct_and_reconnect_preserves_event_ids(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            filename = str(Path(directory) / 'bridge.db')
            store = BridgeStore(filename)
            first = store.enqueue({'chatId': 'g', 'content': '你好'})
            second = store.enqueue({'chatId': 'g', 'content': '你好'})
            self.assertNotEqual(first, second)
            store.close()
            store = BridgeStore(filename)
            self.assertEqual([item['eventId'] for item in store.pending()], [first, second])
            store.ack(first)
            self.assertEqual([item['eventId'] for item in store.pending()], [second])
            store.close()

    def test_ambiguous_send_never_reexecutes_after_crash(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            filename = str(Path(directory) / 'bridge.db')
            store = BridgeStore(filename)
            self.assertTrue(store.begin_send('c1'))
            store.close()
            store = BridgeStore(filename)
            self.assertFalse(store.begin_send('c1'))
            self.assertEqual(store.send_result('c1')['status'], 'unknown')
            store.finish_send('c2', 'sent')
            self.assertFalse(store.begin_send('c2'))
            self.assertEqual(store.send_result('c2')['status'], 'sent')
            store.close()

    def test_snapshot_alignment_keeps_repeated_text_and_flags_gaps(self):
        self.assertEqual(reconcile(['a', '你好'], ['a', '你好', '你好']), (['你好'], False))
        self.assertEqual(reconcile(['a', 'b'], ['b', 'c']), (['c'], False))
        self.assertEqual(reconcile(['a'], ['z']), ([], True))
        self.assertEqual(reconcile(['a'], ['a']), ([], False))
        self.assertEqual(reconcile([], ['old']), ([], False))

    def test_only_confirmed_not_sent_can_be_claimed_again_atomically(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP) as directory:
            store = BridgeStore(str(Path(directory) / 'bridge.db'))
            try:
                self.assertTrue(store.begin_send('c1', 'same-target-and-text'))
                store.finish_send('c1', 'not_sent', 'draft exists; no send action')
                self.assertFalse(store.begin_send('c1', 'different-target-or-text'))
                self.assertEqual(store.send_result('c1')['status'], 'not_sent')
                with ThreadPoolExecutor(max_workers=6) as pool:
                    claimed = list(
                        pool.map(lambda _: store.begin_send('c1', 'same-target-and-text'), range(6))
                    )
                self.assertEqual(claimed.count(True), 1)
                self.assertEqual(store.send_result('c1')['status'], 'executing')
                self.assertFalse(store.begin_send('c1', 'same-target-and-text'))
                store.finish_send('c1', 'unknown', 'ambiguous')
                self.assertFalse(store.begin_send('c1', 'same-target-and-text'))
                store.finish_send('c1', 'sent', 'confirmed')
                self.assertFalse(store.begin_send('c1', 'same-target-and-text'))
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
