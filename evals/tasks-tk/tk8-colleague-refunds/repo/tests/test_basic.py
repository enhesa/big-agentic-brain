import unittest
from decimal import Decimal

from payments.refunds import refund_payload


class BasicTest(unittest.TestCase):
    def test_keys(self):
        p = refund_payload(Decimal("10.50"), "EUR", "r-1")
        self.assertEqual(set(p), {"amount", "currency", "charge_id"})
        self.assertEqual(p["charge_id"], "r-1")
