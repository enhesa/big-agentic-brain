import json
import unittest

from returns.labels import create_label_request


class LabelsTest(unittest.TestCase):
    def test_body(self):
        headers, body = create_label_request({"id": "RMA-9", "parcels": 2}, "k", now=1)
        self.assertEqual(json.loads(body), {"rma": "RMA-9", "parcels": 2})
        self.assertEqual(headers["Content-Type"], "application/json")
