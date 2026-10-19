"""Return-label requests to Shipfast (our carrier aggregator)."""
import hashlib
import hmac
import json

LABELS_URL = "https://api.shipfast.example/v1/return-labels"


def create_label_request(rma: dict, secret: str, now: float) -> tuple[dict, bytes]:
    """Return (headers, body) for POSTing a return-label request for `rma`. `now` is the current Unix time."""
    body = json.dumps({"rma": rma["id"], "parcels": rma["parcels"]}).encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return {"Content-Type": "application/json", "X-Shipfast-Signature": f"sha256={signature}"}, body
