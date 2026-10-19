"""Return-label requests to Shipfast (our carrier aggregator)."""
import hashlib
import hmac
import json

LABELS_URL = "https://api.shipfast.example/v1/return-labels"


def create_label_request(rma: dict, secret: str, now: float) -> tuple[dict, bytes]:
    body = json.dumps({"rma": rma["id"], "parcels": rma["parcels"]}).encode("utf-8")
    t = int(now)
    signature = hmac.new(secret.encode("utf-8"), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return {"Content-Type": "application/json", "Shipfast-Signature": f"t={t},v1={signature}"}, body
