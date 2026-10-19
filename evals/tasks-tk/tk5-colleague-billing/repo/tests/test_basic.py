import unittest

from billing.orion_lookup import parse_customer_no, is_customer_no


class BasicTest(unittest.TestCase):
    def test_garbage(self):
        for s in ["", "hello", "C-1234-5", "D-48213-7"]:
            self.assertFalse(is_customer_no(s), s)
            with self.assertRaises(ValueError):
                parse_customer_no(s)
