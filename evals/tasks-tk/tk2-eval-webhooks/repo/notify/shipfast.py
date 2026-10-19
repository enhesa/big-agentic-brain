"""Outgoing order webhooks to Shipfast (our carrier aggregator)."""
import hashlib
import hmac
import json

SHIPFAST_URL = "https://hooks.shipfast.example/v1/events"


def build_request(event: dict, secret: str, now: float) -> tuple[dict, bytes]:
    """Return (headers, body) for POSTing `event` to Shipfast. `now` is the current Unix time."""
    body = json.dumps(event).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    headers = {"Content-Type": "application/json", "X-Shipfast-Signature": f"sha256={signature}"}
    return headers, body
