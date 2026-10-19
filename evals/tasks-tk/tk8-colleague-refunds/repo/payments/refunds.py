"""Refunds through Paylane, our card payment provider."""
from decimal import Decimal


def refund_payload(amount: Decimal, currency: str, charge_id: str) -> dict:
    """Paylane /v3/refunds request body. `amount` is in major units (e.g. Decimal("10.50")), `currency` an ISO 4217 code."""
    return {"amount": int(amount * 100), "currency": currency.upper(), "charge_id": charge_id}
