import unittest
from datetime import date
from decimal import Decimal

from payroll.journal import Entry, export_payroll

ENTRIES = [Entry("E-17", date(2026, 9, 30), Decimal("4200.00"), Decimal("1300.25")),
           Entry("E-18", date(2026, 9, 30), Decimal("3100.10"), Decimal("800.00"))]


class JournalTest(unittest.TestCase):
    def test_one_record_per_entry(self):
        self.assertEqual(sum("E-1" in line for line in export_payroll(ENTRIES).splitlines()), 2)

    def test_empty(self):
        self.assertNotIn("E-1", export_payroll([]))
