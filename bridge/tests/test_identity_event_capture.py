import hashlib,unittest
from identity_event_capture import bind_new_observations
from identity_occurrences import OccurrenceRegistry

def item(text):return {'kind':'message','name':text,'class':'text'}
def observation(text,runtime,rect,avatar):
    return {'chatId':'g','sessionId':'s','runtimeId':runtime,'rect':rect,'imageHash':avatar*64,
            'textHash':hashlib.sha256(text.encode()).hexdigest(),'visible':True}
class IdentityEventCaptureTests(unittest.TestCase):
    def setUp(self):self.registry=OccurrenceRegistry(clock=lambda:1)
    def test_duplicate_texts_bind_to_their_own_new_occurrences(self):
        old=[item('old')];current=old+[item('重复'),item('重复')]
        a=observation('重复',[1],[0,0,100,80],'a');b=observation('重复',[2],[0,81,100,160],'c')
        result=bind_new_observations(self.registry,'g','s',old,current,[None,a,b],[a,b],['event-a','event-b'])
        self.assertEqual(result,{'event-a':True,'event-b':True})
        self.assertEqual(self.registry.resolve('event-a','g','s',[a,b])['observation'],a)
        self.assertEqual(self.registry.resolve('event-b','g','s',[a,b])['observation'],b)
    def test_mismatch_gap_or_ambiguous_avatar_never_bind(self):
        a=observation('重复',[1],[0,0,100,80],'a');b=observation('重复',[2],[0,81,100,160],'a')
        cases=[([item('old')],[item('重复')],[a],[a],['x']),
               ([item('old')],[item('old'),item('重复')],[None,a],[{**a,'rect':[0,1,100,81]}],['x']),
               ([item('old')],[item('old'),item('重复'),item('重复')],[None,a,b],[a,b],['x','y'])]
        for previous,current,evidence,after,ids in cases:
            with self.subTest(ids=ids):
                registry=OccurrenceRegistry(clock=lambda:1)
                self.assertFalse(any(bind_new_observations(registry,'g','s',previous,current,evidence,after,ids).values()))
    def test_wrong_scope_or_event_count_never_bind(self):
        old=[item('old')];current=old+[item('重复')];a=observation('重复',[1],[0,0,100,80],'a')
        self.assertFalse(any(bind_new_observations(self.registry,'other','s',old,current,[None,a],[a],['x']).values()))
        self.assertEqual(bind_new_observations(self.registry,'g','s',old,current,[None,a],[a],[]),{})
    def test_older_indistinguishable_message_without_visual_evidence_is_not_ignored(self):
        previous=[item('重复')];current=previous+[item('重复')];a=observation('重复',[1],[0,81,100,160],'a')
        reasons={}
        self.assertEqual(bind_new_observations(self.registry,'g','s',previous,current,[None,a],[a],['x'],diagnostics=reasons),{'x':False})
        self.assertEqual(reasons,{'x':'peer_evidence_missing'})
    def test_duplicate_avatar_has_specific_reason(self):
        old=[item('old')];current=old+[item('重复'),item('重复')]
        a=observation('重复',[1],[0,0,100,80],'a');b=observation('重复',[2],[0,81,100,160],'a');reasons={}
        self.assertEqual(bind_new_observations(self.registry,'g','s',old,current,[None,a,b],[a,b],['x','y'],diagnostics=reasons),{'x':False,'y':False})
        self.assertEqual(reasons,{'x':'target_ambiguous','y':'target_ambiguous'})
    def test_name_probe_uses_current_row_without_identifying_by_avatar(self):
        previous=[item('重复')];current=previous+[item('重复')]
        a=observation('重复',[1],[0,81,100,160],'a')
        self.assertEqual(bind_new_observations(self.registry,'g','s',previous,current,[None,a],[a],['x'],name_probe=True),{'x':True})
        self.assertEqual(self.registry.resolve('x','g','s',[a])['status'],'current')

if __name__=='__main__':unittest.main()
