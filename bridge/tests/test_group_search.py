import unittest
from types import SimpleNamespace
from wx_adapter import SafeAttachError, exact_group_result, nickname_from_label

def header(name):return SimpleNamespace(ClassName='mmui::XTableCell',AutomationId='',Name=name)
def row(name):return SimpleNamespace(ClassName='mmui::SearchContentCellView',AutomationId='search_item_'+name,Name=name)

class GroupSearchTests(unittest.TestCase):
    def test_nickname_is_read_from_existing_child_text_without_editing(self):
        label=SimpleNamespace(Name='我在本群的昵称')
        manager=SimpleNamespace(_walk_controls=lambda root,max_depth:[label,SimpleNamespace(Name='测试机器人',ControlTypeName='TextControl')])
        self.assertEqual(nickname_from_label(manager,label),'测试机器人')
    def test_ambiguous_nickname_child_text_is_not_guessed(self):
        label=SimpleNamespace(Name='我在本群的昵称')
        manager=SimpleNamespace(_walk_controls=lambda root,max_depth:[SimpleNamespace(Name=x,ControlTypeName='TextControl') for x in ['我在本群的昵称','first','second']])
        self.assertIsNone(nickname_from_label(manager,label))
    def test_accepts_exact_group_and_requires_group_info_proof(self):
        result=row('合成验收群')
        self.assertIs(exact_group_result([header('群聊'),result],'合成验收群'),result)
    def test_frequent_section_is_a_candidate_but_not_a_group_identity_proof(self):
        result=row('合成验收群')
        self.assertIs(exact_group_result([header('最常使用'),result],'合成验收群'),result)
    def test_contact_alone_or_duplicate_exact_names_are_rejected(self):
        for items in ([header('联系人'),row('合成验收群')],
                      [header('最常使用'),row('合成验收群'),header('群聊'),row('合成验收群')],
                      [header('联系人'),row('合成验收群'),header('群聊'),row('合成验收群')]):
            with self.assertRaises(SafeAttachError):exact_group_result(items,'合成验收群')
    def test_incomplete_group_results_are_not_guessed(self):
        with self.assertRaises(SafeAttachError):
            exact_group_result([header('群聊'),row('合成验收群'),header('查看更多群聊')],'合成验收群')

if __name__=='__main__':unittest.main()
