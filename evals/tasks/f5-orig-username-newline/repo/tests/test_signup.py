import unittest

from accounts.signup import Directory
from accounts.validators import InvalidUsername, normalize_username


class SignupTest(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(normalize_username("Alice_01"), "alice_01")

    def test_reserved(self):
        with self.assertRaises(InvalidUsername):
            normalize_username("Admin")

    def test_support_ticket_4411(self):
        # Support found two accounts that both display as "alice" in the admin UI.
        d = Directory()
        d.signup("alice", "a@example.com")
        with self.assertRaises((InvalidUsername, ValueError)):
            d.signup("alice\n", "mallory@example.com")
        self.assertEqual(list(d.users), ["alice"])
