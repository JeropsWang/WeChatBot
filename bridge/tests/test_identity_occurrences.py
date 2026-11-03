import unittest
from identity_occurrences import OccurrenceRegistry

def row(runtime,rect,avatar):
    return {'chatId':'group-a','sessionId':'session-a','runtimeId':runtime,'rect':rect,
            'imageHash':avatar*64,'textHash':'b'*64,'visible':True}

class IdentityOccurrenceTests(unittest.TestCase):
    def setUp(self):
        self.now=100.0;self.registry=OccurrenceRegistry(clock=lambda:self.now,ttl=10)
        self.first=row([1,2],[0,0,100,80],'a');self.second=row([1,3],[0,81,100,161],'c')
    def test_duplicate_text_events_resolve_to_their_own_bound_occurrence(self):
        self.registry.bind('event-a',self.first);self.registry.bind('event-b',self.second)
        self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[self.first,self.second])['observation'],self.first)
        self.assertEqual(self.registry.resolve('event-b','group-a','session-a',[self.first,self.second])['observation'],self.second)
    def test_wrong_group_session_expiry_or_reused_id_returns_unknown(self):
        self.registry.bind('event-a',self.first)
        for group,session,visible in [('other','session-a',[self.first]),('group-a','new-session',[self.first]),('group-a','session-a',[{**self.first,'imageHash':'c'*64}])]:
            self.assertEqual(self.registry.resolve('event-a',group,session,visible)['status'],'unknown')
        self.now+=11;self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[self.first])['status'],'unknown')
    def test_duplicate_same_text_and_avatar_is_never_resolved(self):
        self.registry.bind('event-a',self.first)
        duplicate={**self.second,'imageHash':self.first['imageHash']}
        self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[self.first,duplicate])['status'],'unknown')
    def test_name_probe_accepts_one_exact_row_even_if_another_avatar_matches(self):
        self.registry.bind('event-a',self.first);duplicate={**self.second,'imageHash':self.first['imageHash']}
        self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[self.first,duplicate],name_probe=True)['status'],'current')
        self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[{**self.first,'rect':[1,0,101,80]},duplicate],name_probe=True)['status'],'unknown')
        self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[self.first,{**duplicate,'runtimeId':self.first['runtimeId']}],name_probe=True)['status'],'unknown')
    def test_restart_invalidates_all_ephemeral_bindings(self):
        self.registry.bind('event-a',self.first);self.registry.clear()
        self.assertEqual(self.registry.resolve('event-a','group-a','session-a',[self.first])['status'],'unknown')

if __name__=='__main__':unittest.main()
