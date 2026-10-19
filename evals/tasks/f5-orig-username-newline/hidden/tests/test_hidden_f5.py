import unittest
from accounts.validators import InvalidUsername, normalize_username
class HiddenTest(unittest.TestCase):
    def test_rejects(self):
        for bad in ["bob\n", "admin\n", "ab", "x" * 21, "bad name", "tab\t", "\nbob"]:
            with self.assertRaises(InvalidUsername, msg=repr(bad)):
                normalize_username(bad)
    def test_accepts(self):
        for good in ["bob", "a.b_c", "x" * 20]:
            self.assertEqual(normalize_username(good), good)
