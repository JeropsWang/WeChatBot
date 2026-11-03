import unittest
from identity_focus import ensure_foreground

class API:
    def __init__(self):self.focus=2;self.attached=False;self.actions=[];self.visible=True;self.block=False
    def is_visible(self,hwnd):return self.visible
    def foreground(self):return self.focus
    def current_thread(self):return 10
    def window_thread(self,hwnd):return 20
    def attach(self,a,b,enabled):self.actions.append(('attach',enabled));self.attached=enabled
    def activate(self,hwnd):
        self.actions.append(('activate',hwnd))
        if self.attached and not self.block:self.focus=hwnd

class FocusTests(unittest.TestCase):
    def test_background_worker_uses_temporary_input_attachment_and_always_detaches(self):
        api=API();self.assertTrue(ensure_foreground(1,api));self.assertFalse(api.attached)
        self.assertEqual(api.actions,[('activate',1),('attach',True),('activate',1),('attach',False)])
    def test_unavailable_or_already_foreground_never_attaches(self):
        api=API();api.visible=False;self.assertFalse(ensure_foreground(1,api));self.assertEqual(api.actions,[])
        api.visible=True;api.focus=1;self.assertTrue(ensure_foreground(1,api));self.assertEqual(api.actions,[])
    def test_failed_activation_is_bounded_and_detaches(self):
        api=API();api.block=True;now=[0]
        def sleep(seconds):now[0]+=seconds
        self.assertFalse(ensure_foreground(1,api,clock=lambda:now[0],sleep=sleep));self.assertLess(now[0],1)
        self.assertFalse(api.attached);self.assertEqual(api.actions[-1],('attach',False))

if __name__=='__main__':unittest.main()
