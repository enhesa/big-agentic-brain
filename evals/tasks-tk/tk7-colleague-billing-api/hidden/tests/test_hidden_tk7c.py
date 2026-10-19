import unittest

from billing_api.auth import InvalidClaims, check_claims

NOW = 1_760_000_000
GOOD = {"iss": "https://gatekeeper.internal", "aud": "svc:billing", "scp": "other.write billing.write", "exp": NOW + 60, "nbf": NOW - 5}


class GatekeeperClaimsTest(unittest.TestCase):
    def ok(self, **over):
        check_claims({**GOOD, **over}, now=NOW)

    def bad(self, **over):
        with self.assertRaises(InvalidClaims):
            check_claims({**GOOD, **over}, now=NOW)

    def test_accepts(self):
        self.ok()
        self.ok(aud=["svc:other", "svc:billing"])
        self.ok(scp="billing.write")
        self.ok(exp=NOW - 100)
        self.ok(nbf=NOW + 100)

    def test_rejects(self):
        self.bad(iss="https://auth.acme.example")
        self.bad(aud="billing")
        self.bad(aud=["svc:other"])
        self.bad(scp="billing.writeonly other.write")
        self.bad(scp="")
        self.bad(exp=NOW - 130)
        self.bad(nbf=NOW + 130)
