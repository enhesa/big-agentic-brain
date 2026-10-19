import unittest
from billing.invoice import invoice
class HiddenTest(unittest.TestCase):
    def test_more(self):
        self.assertEqual(invoice([("1", "0.285"), ("1", "4.445")], "0.135"),
                         {"subtotal": "4.74", "vat": "0.64", "total": "5.38"})
    def test_big(self):
        self.assertEqual(invoice([("1000", "19.995")], "0.23"),
                         {"subtotal": "19995.00", "vat": "4598.85", "total": "24593.85"})
