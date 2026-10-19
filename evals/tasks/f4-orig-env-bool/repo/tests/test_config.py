import unittest

from notify import config
from notify.sender import pick_gateway

PROD = {"NOTIFY_SANDBOX": "false", "NOTIFY_GATEWAY_URL": "https://gw.example.com",
        "NOTIFY_MAX_RETRIES": "5", "NOTIFY_DEBUG": "0"}


class ConfigTest(unittest.TestCase):
    def test_defaults(self):
        cfg = config.load(env={})
        self.assertTrue(cfg["sandbox"])
        self.assertEqual(cfg["max_retries"], 3)

    def test_production_env(self):
        # This is the production deployment's env. Messages must go to the real gateway.
        cfg = config.load(env=PROD)
        self.assertEqual(pick_gateway(cfg), "https://gw.example.com")
        self.assertEqual(cfg["max_retries"], 5)
        self.assertIs(cfg["debug"], False)
