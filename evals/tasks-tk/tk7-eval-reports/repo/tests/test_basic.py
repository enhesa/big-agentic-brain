import unittest

from reports.auth import InvalidClaims, verify_claims


class BasicTest(unittest.TestCase):
    def test_empty_claims_rejected(self):
        with self.assertRaises(InvalidClaims):
            verify_claims({}, now=1000)
