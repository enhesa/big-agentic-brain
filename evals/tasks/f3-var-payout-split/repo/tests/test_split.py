import unittest
from decimal import Decimal

from payouts.split import split


class SplitTest(unittest.TestCase):
    def test_even(self):
        self.assertEqual(split("10.00", ["0.5", "0.5"]), ["5.00", "5.00"])

    def test_thirds_add_up(self):
        parts = split("100.00", ["0.3333333333", "0.3333333333", "0.3333333334"])
        self.assertEqual(sum(Decimal(p) for p in parts), Decimal("100.00"))
        self.assertEqual(parts, ["33.33", "33.33", "33.34"])

    def test_half_up(self):
        # seller 85%, platform 15% of 1.10 -> 0.935 / 0.165 -> half-up 0.94 / 0.17 -> sum 1.11, settle 1c
        self.assertEqual(split("1.10", ["0.85", "0.15"]), ["0.93", "0.17"])

    def test_half_up_exact(self):
        self.assertEqual(split("2.01", ["0.5", "0.5"]), ["1.00", "1.01"])
