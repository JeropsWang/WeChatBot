import unittest
from identity_experiment import run_identity_probe

class Driver:
    def __init__(self):
        self.obs={'chatId':'g','sessionId':'s','runtimeId':[1,2],'rect':[1,2,100,80],
                  'imageHash':'a'*64,'textHash':'b'*64,'visible':True}
        self.rows=[self.obs];self.draft=False;self.popup=False;self.clicked=0;self.name='甲';self.hit=True
    def has_draft(self):return self.draft
    def has_profile_popup(self):return self.popup
    def observations(self):return self.rows
    def target_hit_is_current(self,observation):return self.hit
    def click_avatar(self,observation):self.clicked+=1
    def read_new_profile(self):return self.name

class IdentityExperimentTests(unittest.TestCase):
    def setUp(self):self.driver=Driver();self.candidate=dict(self.driver.obs)
    def test_only_read_name_after_one_checked_click(self):
        result=run_identity_probe(self.driver,self.candidate)
        self.assertEqual(result,{'status':'candidate','name':'甲'});self.assertEqual(self.driver.clicked,1)
    def test_draft_popup_or_bad_hit_never_clicks(self):
        for attr in ('draft','popup','hit'):
            with self.subTest(attr=attr):
                d=Driver();setattr(d,attr,False if attr=='hit' else True)
                self.assertEqual(run_identity_probe(d,self.candidate)['status'],'unknown');self.assertEqual(d.clicked,0)
    def test_changed_or_duplicate_sample_never_clicks(self):
        for rows in ([],[{**self.candidate,'imageHash':'c'*64}], [self.candidate,{**self.candidate,'runtimeId':[9,9],'rect':[1,81,100,159]}]):
            with self.subTest(rows=rows):
                d=Driver();d.rows=rows
                self.assertEqual(run_identity_probe(d,self.candidate)['status'],'unknown');self.assertEqual(d.clicked,0)
    def test_empty_or_missing_name_is_unknown(self):
        self.driver.name='';self.assertEqual(run_identity_probe(self.driver,self.candidate)['status'],'unknown')
    def test_name_probe_allows_same_avatar_on_another_row_but_never_a_moved_target(self):
        self.driver.rows.append({**self.candidate,'runtimeId':[9,9],'rect':[1,81,100,159]})
        self.assertEqual(run_identity_probe(self.driver,self.candidate,name_probe=True)['status'],'candidate')
        moved=Driver();moved.rows=[{**self.candidate,'rect':[1,3,100,81]}]
        self.assertEqual(run_identity_probe(moved,self.candidate,name_probe=True)['status'],'unknown')
        self.assertEqual(moved.clicked,0)

if __name__=='__main__':unittest.main()
