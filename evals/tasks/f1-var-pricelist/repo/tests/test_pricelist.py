import os
import unittest
from decimal import Decimal

from inventory.pricelist import diff_prices, load_prices

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


class PricelistTest(unittest.TestCase):
    def test_supplier_weekly_file(self):
        prices = load_prices(os.path.join(FIX, "supplier_weekly.csv"))
        self.assertEqual(len(prices), 4, f"expected 4 skus, got {sorted(prices)}")
        self.assertEqual(prices["KX-101"], Decimal("0.19"))

    def test_diff(self):
        self.assertEqual(diff_prices({"a": Decimal("1")}, {"a": Decimal("2"), "b": Decimal("1")}),
                         {"a": (Decimal("1"), Decimal("2")), "b": (None, Decimal("1"))})
