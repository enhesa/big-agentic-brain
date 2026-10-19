import re
import unittest

from mailer.promo import build_promo


class PostbirdBroadcastTest(unittest.TestCase):
    def setUp(self):
        self.h = build_promo("ann@example.com", "tok123", "Hello", "<p>Hi</p>")["headers"]

    def test_stream(self):
        self.assertEqual(self.h.get("X-Postbird-Stream"), "broadcast")

    def test_one_click_unsubscribe(self):
        uris = set(re.findall(r"<([^>]+)>", self.h.get("List-Unsubscribe", "")))
        self.assertEqual(uris, {"mailto:unsubscribe+tok123@mail.acme-shop.example", "https://acme-shop.example/unsubscribe/tok123"})
        self.assertEqual(self.h.get("List-Unsubscribe-Post"), "List-Unsubscribe=One-Click")
