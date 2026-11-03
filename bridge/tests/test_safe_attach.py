import threading
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace
from wx_adapter import ExistingWindow, SafeAttachError, WxAdapter


class SafeAttachTests(unittest.TestCase):
    def test_status_does_not_trust_cached_mmui_root_after_accessibility_is_removed(self):
        adapter=WxAdapter();adapter.window=SimpleNamespace(hwnd=123,uia=SimpleNamespace(root=SimpleNamespace(ClassName='mmui::MainWindow')))
        with patch('win32gui.IsWindow',return_value=True),patch('wx4py.core.uiautomation.ControlFromHandle',return_value=SimpleNamespace(ClassName='Qt51514QWindowIcon')):
            self.assertFalse(adapter.status()['connected'])
            self.assertIn('失效',adapter.detail)
    def test_frequent_search_cannot_open_a_window_without_group_info_proof(self):
        adapter=WxAdapter();adapter.window=Mock();item=Mock()
        item.ClassName='mmui::SearchContentCellView';item.AutomationId='search_item_target';item.Name='target'
        header=Mock();header.ClassName='mmui::XTableCell';header.AutomationId='';header.Name='最常使用'
        with patch('wx4py.features.chat.ChatWindow') as chat_type, patch('wx4py.features.groups.GroupManager') as group_type, patch.object(adapter,'_open_session_window') as open_window:
            chat=chat_type.return_value;chat._input_search.return_value=True
            results=chat._get_search_popup.return_value.ListControl.return_value
            results.Exists.return_value=True;results.GetChildren.return_value=[header,item]
            group_type.return_value._open_group_detail.return_value=False
            with self.assertRaisesRegex(SafeAttachError,'群聊详情校验'):adapter._open_exact_group('target')
            open_window.assert_not_called()

    def test_independent_window_uses_only_the_named_safe_menu_action(self):
        adapter=WxAdapter();root=Mock();adapter.window=Mock();adapter.window.uia.root=root
        item=Mock();menu=root.WindowControl.return_value;menu.Exists.return_value=True
        action=menu.MenuItemControl.return_value;action.Exists.return_value=True
        adapter._open_session_window(item)
        item.RightClick.assert_called_once_with(simulateMove=False)
        root.WindowControl.assert_called_once_with(ClassName='mmui::XMenu')
        menu.MenuItemControl.assert_called_once_with(Name='独立窗口显示')
        action.Click.assert_called_once_with(simulateMove=False)
        item.DoubleClick.assert_not_called()
    def test_missing_independent_window_menu_refuses_without_alternative_clicks(self):
        adapter=WxAdapter();root=Mock();adapter.window=Mock();adapter.window.uia.root=root
        item=Mock();root.WindowControl.return_value.Exists.return_value=False
        with self.assertRaises(SafeAttachError):adapter._open_session_window(item)
        root.WindowControl.return_value.MenuItemControl.assert_not_called()
        root.SendKeys.assert_called_once_with('{Esc}')

    def test_unsupported_tree_refuses_before_binding_or_ui_action(self):
        adapter = WxAdapter()
        diagnostic = {'supported': False, 'detail': 'unsupported tree', 'processes': []}
        with patch('wx_adapter.inventory', return_value=diagnostic), patch('wx_adapter.ExistingWindow') as window:
            with self.assertRaises(SafeAttachError): adapter.attach()
            window.assert_not_called()
        self.assertEqual(adapter.diagnostics, diagnostic)
        self.assertIsNone(adapter.window)

    def test_automatic_refresh_is_disabled(self):
        window = ExistingWindow.__new__(ExistingWindow)
        with self.assertRaisesRegex(SafeAttachError, '禁用'): window.refresh()

    def test_uia_access_from_another_thread_is_rejected(self):
        adapter, errors = WxAdapter(), []
        def wrong_thread():
            try: adapter._thread()
            except RuntimeError as exc: errors.append(str(exc))
        thread = threading.Thread(target=wrong_thread)
        thread.start(); thread.join()
        self.assertEqual(len(errors), 1)


if __name__ == '__main__': unittest.main()
