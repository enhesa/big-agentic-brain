"""Charges through Paylane, our card payment provider."""
from decimal import Decimal


def charge_payload(amount: Decimal, currency: str, reference: str) -> dict:
    """Paylane /v3/charges request body. `amount` is in major units (e.g. Decimal("10.50")), `currency` an ISO 4217 code."""
    return {"amount": int(amount * 100), "currency": currency.upper(), "reference": reference}
