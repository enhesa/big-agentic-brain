import csv
import io
import unittest
from datetime import date
from decimal import Decimal

from payroll.journal import COLUMNS, Entry, export_payroll


class LedgerlyV2Test(unittest.TestCase):
    def setUp(self):
        self.out = export_payroll([Entry("E-17", date(2026, 9, 30), Decimal("4200.00"), Decimal("1300.25")),
                                   Entry("E-19", date(2026, 12, 31), Decimal("1234567.80"), Decimal("1234600.00"))])

    def rows(self):
        return list(csv.reader(io.StringIO(self.out.split("\r\n", 1)[1], newline=""), delimiter=";"))

    def test_marker_and_crlf(self):
        self.assertTrue(self.out.startswith("#LEDGERLY;2\r\n"))
        self.assertTrue(self.out.endswith("\r\n"))
        self.assertNotIn("\n", self.out.replace("\r\n", ""))

    def test_fields(self):
        rows = self.rows()
        self.assertEqual(rows[0], COLUMNS)
        self.assertEqual(rows[1], ["E-17", "30.09.2026", "4200,00", "1300,25", "2899,75"])
        self.assertEqual(rows[2], ["E-19", "31.12.2026", "1234567,80", "1234600,00", "-32,20"])
