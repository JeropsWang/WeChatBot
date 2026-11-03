import unittest
from accessibility_lease import maintain_accessibility


class AccessibilityLeaseTests(unittest.TestCase):
    def run_lease(self, values, alive=None, limit=30):
        observed=iter(values);writes=[];reports=[];ticks=[0]
        def read():return next(observed)
        def sleep(_):ticks[0]+=.5
        if alive is None:
            alive=lambda:ticks[0]<len(values)*.5
        maintain_accessibility(read,lambda:writes.append(1),alive,reports.append,
                               clock=lambda:ticks[0],sleep=sleep,max_repairs=limit)
        return writes,reports

    def test_repairs_drift_while_owned_session_is_alive(self):
        writes,reports=self.run_lease([b'\x01',b'\x00',b'\x01'])
        self.assertEqual(writes,[1])
        self.assertEqual(reports,[{'reactivations':1}])

    def test_never_reenables_after_the_owner_exits(self):
        states=iter([True,False])
        writes,_=self.run_lease([b'\x00'],lambda:next(states))
        self.assertEqual(writes,[])

    def test_unexpected_flag_refuses_to_write(self):
        with self.assertRaisesRegex(RuntimeError,'Unexpected'):
            self.run_lease([b'\x02'])

    def test_enable_can_cancel_if_owner_exits_during_module_check(self):
        reports=[]
        maintain_accessibility(lambda:b'\x00',lambda:False,lambda:True,reports.append)
        self.assertEqual(reports,[])

    def test_stops_if_another_writer_repeatedly_changes_the_flag(self):
        with self.assertRaisesRegex(RuntimeError,'repeatedly'):
            self.run_lease([b'\x00',b'\x00'],limit=1)
