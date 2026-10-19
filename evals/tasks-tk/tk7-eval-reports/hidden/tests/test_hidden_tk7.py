import unittest

from reports.auth import InvalidClaims, verify_claims

NOW = 1_760_000_000
GOOD = {"iss": "https://gatekeeper.internal", "aud": "svc:reports", "scp": "other.write reports.read", "exp": NOW + 60, "nbf": NOW - 5}


class GatekeeperClaimsTest(unittest.TestCase):
    def ok(self, **over):
        verify_claims({**GOOD, **over}, now=NOW)

    def bad(self, **over):
        with self.assertRaises(InvalidClaims):
            verify_claims({**GOOD, **over}, now=NOW)

    def test_accepts(self):
        self.ok()
        self.ok(aud=["svc:other", "svc:reports"])
        self.ok(scp="reports.read")
        self.ok(exp=NOW - 100)
        self.ok(nbf=NOW + 100)

    def test_rejects(self):
        self.bad(iss="https://auth.acme.example")
        self.bad(aud="reports")
        self.bad(aud=["svc:other"])
        self.bad(scp="reports.readonly other.write")
        self.bad(scp="")
        self.bad(exp=NOW - 130)
        self.bad(nbf=NOW + 130)
