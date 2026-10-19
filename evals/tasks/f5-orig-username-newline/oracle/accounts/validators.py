import re

USERNAME_RE = re.compile(r"^[a-z0-9_.]{3,20}$")
RESERVED = {"admin", "root", "support", "billing"}


class InvalidUsername(ValueError):
    pass


def normalize_username(raw):
    """Lower-case and validate a username: 3-20 chars of a-z, 0-9, '_' or '.'."""
    u = raw.lower()
    if not USERNAME_RE.fullmatch(u):
        raise InvalidUsername(raw)
    if u in RESERVED:
        raise InvalidUsername(raw)
    return u
