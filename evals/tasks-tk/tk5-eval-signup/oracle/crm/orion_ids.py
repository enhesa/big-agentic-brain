"""Orion CRM customer numbers, as typed by customers in the signup form."""
import re

_PATTERN = re.compile(r"^(?:C-(\d{5})-([\dX])|(\d{5})([\dX]))$")
_WEIGHTS = (6, 5, 4, 3, 2)


def _check_char(digits: str) -> str:
    k = 11 - sum(int(d) * w for d, w in zip(digits, _WEIGHTS)) % 11
    return "0" if k == 11 else "X" if k == 10 else str(k)


def _parse(customer_no: str):
    m = _PATTERN.match(customer_no.strip().upper())
    if not m:
        return None
    digits, check = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
    return (digits, check) if _check_char(digits) == check else None


def is_valid(customer_no: str) -> bool:
    return _parse(customer_no) is not None


def normalize(customer_no: str) -> str:
    p = _parse(customer_no)
    if p is None:
        raise ValueError(f"invalid Orion customer number: {customer_no!r}")
    return f"C-{p[0]}-{p[1]}"
