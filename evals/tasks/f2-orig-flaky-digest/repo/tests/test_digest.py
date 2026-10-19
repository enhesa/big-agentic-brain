import unittest

from reports.digest import render_digest, top_tags

EVENTS = [
    {"tags": ["deploy", "api", "Deploy"]},
    {"tags": ["infra", "api", "billing", "docs"]},
    {"tags": ["deploy", "infra", "zeta", "alpha", "billing"]},
    {"tags": ["docs", "zeta", "alpha"]},
]


class DigestTest(unittest.TestCase):
    def test_top_tags_counts(self):
        self.assertEqual(top_tags([{"tags": ["a", "A", "b"]}, {"tags": ["a"]}], n=1), ["a"])

    def test_digest(self):
        self.assertEqual(render_digest("Ana", EVENTS),
                         "Hi Ana, this week you had 4 events.\nTop tags: alpha, api, billing")

    def test_top_five(self):
        self.assertEqual(top_tags(EVENTS, n=5), ["alpha", "api", "billing", "deploy", "docs"])
