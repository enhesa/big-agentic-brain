import re
import unicodedata

SLUG_RE = re.compile(r"^[\w-]+$")
_NON_WORD = re.compile(r"[^\w\s-]")
_SPACES = re.compile(r"[\s_]+")


def slugify(title):
    """'Café Opening: 2026!' -> 'cafe-opening-2026'"""
    s = unicodedata.normalize("NFKD", title)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = _NON_WORD.sub("", s).strip().lower()
    return _SPACES.sub("-", s).strip("-")


def is_valid_slug(slug):
    """Slugs editors type by hand are checked before publishing."""
    return bool(SLUG_RE.match(slug)) and "_" not in slug and slug == slug.lower()
