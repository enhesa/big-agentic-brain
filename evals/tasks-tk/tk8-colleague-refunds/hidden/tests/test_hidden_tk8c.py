import unittest
from decimal import Decimal

from payments.refunds import refund_payload

CASES = [
    (Decimal("10.50"), "EUR", "1050", "eur"),
    (Decimal("1500"), "JPY", "1500", "jpy"),
    (Decimal("25000"), "KRW", "25000", "krw"),
    (Decimal("12.345"), "KWD", "12345", "kwd"),
    (Decimal("1.5"), "BHD", "1500", "bhd"),
    (Decimal("0.125"), "USD", "13", "usd"),
    (Decimal("19.99"), "gbp", "1999", "gbp"),
]


class PaylaneV3Test(unittest.TestCase):
    def test_cases(self):
        for amount, cur, minor, low in CASES:
            with self.subTest(amount=str(amount), currency=cur):
                p = refund_payload(amount, cur, "r-1")
                self.assertEqual(p["amount"], minor)
                self.assertEqual(p["currency"], low)
