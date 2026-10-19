import os
import unittest
from decimal import Decimal

from orders.importer import load_orders

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


class ImporterTest(unittest.TestCase):
    def test_manual_file(self):
        orders = load_orders(os.path.join(FIX, "manual.csv"))
        self.assertEqual([o.order_id for o in orders], ["M-1"])

    def test_erp_export(self):
        # Real nightly export from the ERP (saved from Excel on the finance laptop).
        orders = load_orders(os.path.join(FIX, "erp_export.csv"))
        self.assertEqual([o.order_id for o in orders], ["A-1001", "A-1002", "A-1003"])
        self.assertEqual(orders[0].amount, Decimal("1234.50"))
        self.assertEqual(orders[1].amount, Decimal("99.95"))
