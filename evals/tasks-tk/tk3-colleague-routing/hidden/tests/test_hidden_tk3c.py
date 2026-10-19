import unittest

from routing.geo_batch import GeoError, QuotaExceeded, lookup


def fake(responses):
    calls = []

    def transport(arg):
        calls.append(arg)
        return responses[min(len(calls), len(responses)) - 1]
    return transport, calls


class GeoApiRulesTest(unittest.TestCase):
    def test_429_waits_retry_after_ms(self):
        transport, calls = fake([(429, {"Retry-After-Ms": "1500"}, ""), (200, {}, '{"lat": 1.5}')])
        sleeps = []
        self.assertEqual(lookup("x", transport, sleep=sleeps.append), {"lat": 1.5})
        self.assertEqual(len(sleeps), 1)
        self.assertAlmostEqual(sleeps[0], 1.5)

    def test_429_without_header_waits_one_second(self):
        transport, calls = fake([(429, {}, ""), (200, {}, '{"lat": 1}')])
        sleeps = []
        lookup("x", transport, sleep=sleeps.append)
        self.assertEqual(len(sleeps), 1)
        self.assertAlmostEqual(sleeps[0], 1.0)

    def test_503_is_quota_and_not_retried(self):
        transport, calls = fake([(503, {"Retry-After": "1"}, ""), (200, {}, '{"lat": 1}')])
        sleeps = []
        with self.assertRaises(QuotaExceeded):
            lookup("x", transport, sleep=sleeps.append)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sleeps, [])

    def test_at_most_three_retries(self):
        transport, calls = fake([(429, {"Retry-After-Ms": "10"}, "")])
        sleeps = []
        with self.assertRaises(GeoError):
            lookup("x", transport, sleep=sleeps.append)
        self.assertEqual(len(calls), 4)
