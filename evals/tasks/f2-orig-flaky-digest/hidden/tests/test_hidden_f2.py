import unittest

from reports.digest import top_tags


class HiddenTest(unittest.TestCase):
    def test_ties_alpha(self):
        ev = [{"tags": list("qwertyuiop")}, {"tags": ["z", "y"]}]
        self.assertEqual(top_tags(ev, n=4), ["y", "e", "i", "o"])

    def test_frequency_first(self):
        ev = [{"tags": ["m", "b"]}, {"tags": ["m"]}, {"tags": ["c", "m", "b"]}]
        self.assertEqual(top_tags(ev, n=3), ["m", "b", "c"])
