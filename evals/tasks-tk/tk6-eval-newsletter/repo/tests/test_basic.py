import unittest

from mailer.newsletter import build_newsletter


class BasicTest(unittest.TestCase):
    def test_payload(self):
        p = build_newsletter("ann@example.com", "tok1", "Hello", "<p>Hi</p>")
        self.assertEqual(p["to"], "ann@example.com")
        self.assertEqual(p["subject"], "Hello")
        self.assertIn("headers", p)
