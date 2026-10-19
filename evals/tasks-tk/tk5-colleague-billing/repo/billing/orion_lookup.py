"""Orion CRM customer numbers on billing documents (e.g. "C-48213-7")."""
import re

_PATTERN = re.compile(r"^C-(\d{5})-(\d)$")


def _luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


def is_customer_no(customer_no: str) -> bool:
    m = _PATTERN.match(customer_no.strip().upper())
    return bool(m) and _luhn_ok(m.group(1) + m.group(2))


def parse_customer_no(customer_no: str) -> str:
    """Canonical form used in our database. Raises ValueError for invalid numbers."""
    s = customer_no.strip().upper()
    if not is_customer_no(s):
        raise ValueError(f"invalid Orion customer number: {customer_no!r}")
    return s
