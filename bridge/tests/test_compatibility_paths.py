"""纯路径选择测试；不枚举进程、不读写进程内存。"""
import unittest
from compatibility_paths import select_visible_client, select_weixin_module

class CompatibilityPathTests(unittest.TestCase):
    def test_arbitrary_install_location(self):
        client={'pid':7,'executable':r'X:\Apps\Weixin.exe','windows':[{'className':'mmui::MainWindow','visible':True}]}
        self.assertEqual(select_visible_client([client]),client)
        self.assertEqual(select_weixin_module([r'X:\Apps\4.1\Weixin.dll',r'C:\Windows\system.dll']),r'X:\Apps\4.1\Weixin.dll')
    def test_ambiguous_or_invisible_clients_fail_closed(self):
        client={'pid':7,'executable':r'X:\Weixin.exe','windows':[{'className':'mmui::MainWindow','visible':True}]}
        for processes in [[],[client,client],[dict(client,windows=[])]]:
            with self.assertRaises(RuntimeError):select_visible_client(processes)
        for modules in [[],[r'X:\Weixin.dll',r'Y:\Weixin.dll']]:
            with self.assertRaises(RuntimeError):select_weixin_module(modules)
