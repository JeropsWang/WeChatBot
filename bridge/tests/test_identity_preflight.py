import unittest
from identity_preflight import validate_observation,select_unique_observation

class IdentityPreflightTests(unittest.TestCase):
    def setUp(self):
        self.candidate={'chatId':'test-group','sessionId':'session-one','runtimeId':[1,2,3],
                        'rect':[10,20,200,100],'imageHash':'a'*64,'textHash':'b'*64,'visible':True}
    def test_identical_live_observation_can_continue_to_manual_validation(self):
        self.assertEqual(validate_observation(self.candidate,dict(self.candidate))['status'],'current')
    def test_changed_window_or_content_or_geometry_never_uses_old_target(self):
        for changed in ({'chatId':'other'},{'sessionId':'new'},{'runtimeId':[1,2,4]},
                        {'rect':[10,21,200,101]},{'imageHash':'c'*64},{'textHash':'d'*64},{'visible':False}):
            with self.subTest(changed=changed):
                self.assertEqual(validate_observation(self.candidate,{**self.candidate,**changed})['status'],'unknown')
    def test_absent_or_incomplete_observation_does_not_authorize_click(self):
        for current in (None,{}, {'chatId':'test-group'}):
            self.assertEqual(validate_observation(self.candidate,current)['status'],'unknown')
    def test_same_text_can_be_distinguished_only_by_unique_avatar(self):
        other={**self.candidate,'runtimeId':[1,2,4],'rect':[10,101,200,181],'imageHash':'c'*64}
        self.assertEqual(select_unique_observation(self.candidate,[self.candidate,other])['status'],'current')
        duplicate={**other,'imageHash':self.candidate['imageHash']}
        self.assertEqual(select_unique_observation(self.candidate,[self.candidate,duplicate])['status'],'unknown')
    def test_target_must_be_present_exactly_once(self):
        self.assertEqual(select_unique_observation(self.candidate,[])['status'],'unknown')
        self.assertEqual(select_unique_observation(self.candidate,[self.candidate,self.candidate])['status'],'unknown')
    def test_reused_runtime_id_in_same_frame_is_ambiguous(self):
        other={**self.candidate,'rect':[10,101,200,181],'imageHash':'c'*64}
        self.assertEqual(select_unique_observation(self.candidate,[self.candidate,other])['status'],'unknown')

if __name__=='__main__':unittest.main()
