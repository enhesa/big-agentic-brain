import unittest
from cms.slugs import is_valid_slug
class HiddenTest(unittest.TestCase):
    def test_more_bad(self):
        for slug in ["a\n", "\u00fcber", "x\u00b2", "has space", "UPPER", "under_score", "", "\u0441ale"]:
            self.assertFalse(is_valid_slug(slug), repr(slug))
    def test_good(self):
        for slug in ["a", "a-b-1", "2026"]:
            self.assertTrue(is_valid_slug(slug), slug)
