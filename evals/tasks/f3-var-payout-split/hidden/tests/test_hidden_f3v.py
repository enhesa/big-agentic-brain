import unittest
from decimal import Decimal
from payouts.split import split
class HiddenTest(unittest.TestCase):
    def test_sum_many(self):
        for total in ["0.01", "0.07", "1.00", "19.99", "1234.57"]:
            parts = split(total, ["0.7", "0.2", "0.1"])
            self.assertEqual(sum(Decimal(p) for p in parts), Decimal(total), (total, parts))
    def test_values(self):
        # 0.035->0.04, 0.01, 0.005->0.01 (sum 0.06) -> largest share gives back 1c
        self.assertEqual(split("0.05", ["0.7", "0.2", "0.1"]), ["0.03", "0.01", "0.01"])
        # 5.025->5.03, 3.015->3.02, 2.01 (sum 10.06) -> largest share gives back 1c
        self.assertEqual(split("10.05", ["0.5", "0.3", "0.2"]), ["5.02", "3.02", "2.01"])
