import os
import unittest
from decimal import Decimal

from inventory.pricelist import load_prices

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


class HiddenTest(unittest.TestCase):
    def test_semicolon_bom(self):
        self.assertEqual(load_prices(os.path.join(FIX, "supplier_semicolon.csv")),
                         {"ZZ-1": Decimal("0.02"), "ZZ-2": Decimal("0.05")})

    def test_plain(self):
        self.assertEqual(load_prices(os.path.join(FIX, "plain.csv")), {"P-1": Decimal("1.00")})
