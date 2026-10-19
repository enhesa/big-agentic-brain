import unittest
from decimal import Decimal

from payments.paylane import charge_payload


class BasicTest(unittest.TestCase):
    def test_keys(self):
        p = charge_payload(Decimal("10.50"), "EUR", "r-1")
        self.assertEqual(set(p), {"amount", "currency", "reference"})
        self.assertEqual(p["reference"], "r-1")
