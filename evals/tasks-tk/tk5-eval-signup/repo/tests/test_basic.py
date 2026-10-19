import unittest

from crm.orion_ids import normalize, is_valid


class BasicTest(unittest.TestCase):
    def test_garbage(self):
        for s in ["", "hello", "C-1234-5", "D-48213-7"]:
            self.assertFalse(is_valid(s), s)
            with self.assertRaises(ValueError):
                normalize(s)
