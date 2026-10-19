import csv
import io
import unittest
from datetime import date
from decimal import Decimal

from billing.ledgerly_export import COLUMNS, export_invoices
from billing.models import Invoice


class LedgerlyV2Test(unittest.TestCase):
    def setUp(self):
        self.out = export_invoices([
            Invoice("INV-1001", "Northwind BV", date(2026, 9, 1), date(2026, 10, 1), Decimal("100.00"), Decimal("21.00")),
            Invoice("INV-1003", "Smith; Jones Ltd", date(2026, 12, 31), date(2027, 1, 30), Decimal("1234567.80"), Decimal("-5.25")),
        ])

    def rows(self):
        return list(csv.reader(io.StringIO(self.out.split("\r\n", 1)[1], newline=""), delimiter=";"))

    def test_marker_and_crlf(self):
        self.assertTrue(self.out.startswith("#LEDGERLY;2\r\n"))
        self.assertTrue(self.out.endswith("\r\n"))
        self.assertNotIn("\n", self.out.replace("\r\n", ""))

    def test_fields(self):
        rows = self.rows()
        self.assertEqual(rows[0], COLUMNS)
        self.assertEqual(rows[1], ["INV-1001", "Northwind BV", "01.09.2026", "01.10.2026", "100,00", "21,00", "121,00"])
        self.assertEqual(rows[2], ["INV-1003", "Smith; Jones Ltd", "31.12.2026", "30.01.2027", "1234567,80", "-5,25", "1234562,55"])
