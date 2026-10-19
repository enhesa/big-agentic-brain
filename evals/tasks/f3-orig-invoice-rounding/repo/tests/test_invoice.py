import unittest

from billing.invoice import invoice, line_total


class InvoiceTest(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(invoice([("2", "10.00")], "0.23"),
                         {"subtotal": "20.00", "vat": "4.60", "total": "24.60"})

    # Reference cases from finance's spreadsheet (they reconcile against the bank).
    def test_finance_reference_1(self):
        self.assertEqual(invoice([("1", "2.675"), ("3", "0.125")], "0.23"),
                         {"subtotal": "3.06", "vat": "0.70", "total": "3.76"})

    def test_finance_reference_2(self):
        self.assertEqual(invoice([("1", "1.005"), ("1", "0.015")], "0.06"),
                         {"subtotal": "1.03", "vat": "0.06", "total": "1.09"})

    def test_finance_reference_3(self):
        self.assertEqual(invoice([("7", "1.15")], "0.21"),
                         {"subtotal": "8.05", "vat": "1.69", "total": "9.74"})
