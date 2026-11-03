import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from identity_sample_driver import SampleDriver

NAME_ID = 'right_v_view.nickname_button_view.display_name_text'


def field(name):
    return SimpleNamespace(AutomationId=NAME_ID, Name=name)


class ProfileNameLoadingTests(unittest.TestCase):
    def read(self, frames, profiles=None):
        driver = SampleDriver.__new__(SampleDriver)
        driver.opened_profile = None
        driver._profiles = profiles or Mock(return_value=[11])
        clock = [0.0]
        last = frames[-1]
        remaining = iter(frames)

        def walk(*args, **kwargs):
            return [(v, 1) for v in next(remaining, last)]

        def sleep(seconds):
            clock[0] += seconds

        with patch('identity_sample_driver.time.monotonic', side_effect=lambda: clock[0]), patch(
            'identity_sample_driver.time.sleep', side_effect=sleep
        ), patch('wx4py.core.uiautomation.ControlFromHandle', return_value=Mock()), patch(
            'wx4py.core.uiautomation.WalkControl', side_effect=walk
        ):
            return driver.read_new_profile()

    def test_waits_for_the_real_name_after_the_card_window_appears(self):
        self.assertEqual(self.read([[], [field('')], [field('癡訫')], [field('癡訫')]]), '癡訫')

    def test_deduplicates_identical_nodes_without_choosing_conflicting_names(self):
        self.assertEqual(self.read([[field('癡訫'), field('癡訫')]]), '癡訫')
        self.assertIsNone(self.read([[field('甲'), field('乙')]]))

    def test_never_reads_a_replacement_card_or_an_empty_card(self):
        self.assertIsNone(self.read([[]], Mock(side_effect=[[11], [12]])))
        self.assertIsNone(self.read([[]]))

    def test_punctuation_only_profile_name_is_a_valid_name(self):
        self.assertEqual(self.read([[field('！')]]), '！')
