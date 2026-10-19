import unittest

from billing_api.auth import InvalidClaims, check_claims


class BasicTest(unittest.TestCase):
    def test_empty_claims_rejected(self):
        with self.assertRaises(InvalidClaims):
            check_claims({}, now=1000)
