import unittest

from cms.slugs import is_valid_slug, slugify


class SlugTest(unittest.TestCase):
    def test_slugify(self):
        self.assertEqual(slugify("Café Opening: 2026!"), "cafe-opening-2026")

    def test_valid(self):
        self.assertTrue(is_valid_slug("spring-sale-2026"))

    def test_cdn_rejected_these(self):
        # The CDN answered 400 for these published slugs; our validator had accepted them.
        for slug in ["summer-sale\n", "caf\u00e9-news", "top-\u0663-picks"]:
            self.assertFalse(is_valid_slug(slug), repr(slug))
