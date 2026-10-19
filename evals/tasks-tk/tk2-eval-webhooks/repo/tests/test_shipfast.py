import json
import unittest

from notify.events import order_shipped
from notify.shipfast import build_request


class ShipfastTest(unittest.TestCase):
    def test_body_is_event_json(self):
        event = order_shipped("A-1", "TRK1")
        headers, body = build_request(event, "k", now=1)
        self.assertEqual(json.loads(body), event)
        self.assertEqual(headers["Content-Type"], "application/json")
