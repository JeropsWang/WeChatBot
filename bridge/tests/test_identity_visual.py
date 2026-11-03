import unittest
from PIL import Image,ImageDraw
from identity_visual import avatar_candidates

class AvatarCandidateTests(unittest.TestCase):
    def make(self):return Image.new('RGB',(900,115),(30,30,31))
    def square(self,img,box,color=(190,110,80)):ImageDraw.Draw(img).rectangle(box,fill=color)
    def test_finds_single_bounded_left_avatar(self):
        im=self.make();self.square(im,(30,12,83,65));self.square(im,(110,45,270,100),(62,62,65))
        self.assertEqual(avatar_candidates(im),[(30,12,84,66)])
    def test_finds_right_avatar_for_outgoing_message(self):
        im=self.make();self.square(im,(816,12,869,65));self.assertEqual(avatar_candidates(im),[(816,12,870,66)])
    def test_ambiguous_or_missing_does_not_choose_a_target(self):
        im=self.make();self.square(im,(20,12,73,65));self.square(im,(110,12,163,65))
        self.assertEqual(avatar_candidates(im),[])
        self.assertEqual(avatar_candidates(self.make()),[])
    def test_dark_avatar_internal_columns_do_not_split_one_avatar(self):
        im=Image.new('RGB',(897,259),(30,30,31));draw=ImageDraw.Draw(im)
        draw.rectangle((31,13,65,66),fill=(180,180,180))
        draw.rectangle((66,13,77,20),fill=(180,180,180))
        draw.rectangle((78,13,84,66),fill=(180,180,180))
        draw.rectangle((106,45,303,242),fill=(230,210,70))
        self.assertEqual(avatar_candidates(im),[(31,13,85,67)])
    def test_still_rejects_two_nearby_avatar_sized_components(self):
        im=self.make();self.square(im,(20,12,73,65));self.square(im,(82,12,135,65))
        self.assertEqual(avatar_candidates(im),[])

if __name__=='__main__':unittest.main()
