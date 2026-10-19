"""Charges through Paylane, our card payment provider."""
from decimal import ROUND_HALF_UP, Decimal

ZERO_DECIMAL = {"JPY", "KRW", "CLP", "VND"}
THREE_DECIMAL = {"BHD", "KWD", "OMR", "JOD", "TND"}


def charge_payload(amount: Decimal, currency: str, reference: str) -> dict:
    code = currency.upper()
    exp = 0 if code in ZERO_DECIMAL else 3 if code in THREE_DECIMAL else 2
    minor = (Decimal(amount) * (10 ** exp)).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return {"amount": str(int(minor)), "currency": code.lower(), "reference": reference}
