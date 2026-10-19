import os
import unittest
from decimal import Decimal

from orders.importer import load_orders

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


class HiddenTest(unittest.TestCase):
    def test_bom_comma_file(self):
        orders = load_orders(os.path.join(FIX, "erp_export2.csv"))
        self.assertEqual([o.order_id for o in orders], ["B-1", "B-2"])
        self.assertEqual(orders[1].amount, Decimal("7.25"))

    def test_plain_still_works(self):
        self.assertEqual(len(load_orders(os.path.join(FIX, "manual.csv"))), 1)
