import unittest

from geo.client import GeoApiError, geocode


class BasicTest(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(geocode("x", lambda a: (200, {}, '{"lat": 2}'), sleep=lambda s: None), {"lat": 2})

    def test_not_found(self):
        with self.assertRaises(GeoApiError):
            geocode("x", lambda a: (404, {}, ""), sleep=lambda s: None)
