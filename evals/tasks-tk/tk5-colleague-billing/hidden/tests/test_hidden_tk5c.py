import unittest

from billing.orion_lookup import parse_customer_no, is_customer_no

VALID = {"C-48213-7": "C-48213-7", "c-48213-7": "C-48213-7", " C-20000-x ": "C-20000-X", "C-20000-X": "C-20000-X",
         "482137": "C-48213-7", "20000X": "C-20000-X", "C-11000-0": "C-11000-0", "C-10007-2": "C-10007-2", "C-30516-2": "C-30516-2"}
INVALID = ["C-48213-6", "C-20000-0", "C-10007-X", "C-11000-X", "4821370", "C-4821-37", "C-30516-3"]


class OrionCheckCharTest(unittest.TestCase):
    def test_valid(self):
        for raw, canonical in VALID.items():
            with self.subTest(raw=raw):
                self.assertTrue(is_customer_no(raw))
                self.assertEqual(parse_customer_no(raw), canonical)

    def test_invalid(self):
        for raw in INVALID:
            with self.subTest(raw=raw):
                self.assertFalse(is_customer_no(raw))
                with self.assertRaises(ValueError):
                    parse_customer_no(raw)
