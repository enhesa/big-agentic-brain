import unittest
from datetime import date
from decimal import Decimal

from billing.ledgerly_export import export_invoices
from billing.models import Invoice

INVOICES = [
    Invoice("INV-1001", "Northwind BV", date(2026, 9, 1), date(2026, 10, 1), Decimal("100.00"), Decimal("21.00")),
    Invoice("INV-1002", "Contoso GmbH", date(2026, 9, 3), date(2026, 10, 3), Decimal("2500.50"), Decimal("475.10")),
]


class ExportTest(unittest.TestCase):
    def test_one_record_per_invoice(self):
        self.assertEqual(sum("INV-" in line for line in export_invoices(INVOICES).splitlines()), 2)

    def test_customers_present(self):
        out = export_invoices(INVOICES)
        self.assertIn("Northwind BV", out)
        self.assertIn("Contoso GmbH", out)

    def test_empty(self):
        self.assertNotIn("INV-", export_invoices([]))
