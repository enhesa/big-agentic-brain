"""Outgoing order webhooks to Shipfast (our carrier aggregator)."""
import hashlib
import hmac
import json

SHIPFAST_URL = "https://hooks.shipfast.example/v1/events"


def build_request(event: dict, secret: str, now: float) -> tuple[dict, bytes]:
    body = json.dumps(event).encode("utf-8")
    t = int(now)
    signature = hmac.new(secret.encode("utf-8"), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return {"Content-Type": "application/json", "Shipfast-Signature": f"t={t},v1={signature}"}, body
