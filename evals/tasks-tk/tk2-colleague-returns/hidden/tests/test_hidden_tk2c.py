import hashlib
import hmac
import json
import unittest

from returns.labels import create_label_request


class ShipfastV1SigningTest(unittest.TestCase):
    def test_signature_header(self):
        headers, body = create_label_request({"id": "RMA-1", "parcels": 1}, "whsec_test", now=1760000000.25)
        expected = hmac.new(b"whsec_test", b"1760000000." + body, hashlib.sha256).hexdigest()
        self.assertEqual(headers.get("Shipfast-Signature"), f"t=1760000000,v1={expected}")

    def test_body_unchanged_and_timestamp_bound(self):
        h1, b1 = create_label_request({"id": "RMA-1", "parcels": 1}, "whsec_test", now=1760000000)
        h2, b2 = create_label_request({"id": "RMA-1", "parcels": 1}, "whsec_test", now=1760000060)
        self.assertEqual(json.loads(b1), {"rma": "RMA-1", "parcels": 1})
        self.assertNotEqual(h1["Shipfast-Signature"], h2["Shipfast-Signature"])
        self.assertTrue(h2["Shipfast-Signature"].startswith("t=1760000060,v1="))
