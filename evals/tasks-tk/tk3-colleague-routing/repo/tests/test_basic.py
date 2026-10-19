import unittest

from routing.geo_batch import GeoError, lookup


class BasicTest(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(lookup("x", lambda a: (200, {}, '{"lat": 2}'), sleep=lambda s: None), {"lat": 2})

    def test_not_found(self):
        with self.assertRaises(GeoError):
            lookup("x", lambda a: (404, {}, ""), sleep=lambda s: None)
