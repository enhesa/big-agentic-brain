"""Batch address lookups for route planning, via geo-api (the platform team's internal geocoding service)."""
import json
import time


class GeoError(Exception):
    pass


class QuotaExceeded(GeoError):
    pass


MAX_ATTEMPTS = 10


def lookup(addr: str, transport, sleep=time.sleep) -> dict:
    """Look up `addr`. `transport(addr)` returns (status, headers, body)."""
    for _ in range(MAX_ATTEMPTS):
        status, headers, body = transport(addr)
        if status == 200:
            return json.loads(body)
        if status in (429, 503):
            sleep(float(headers.get("Retry-After", 1)))
            continue
        raise GeoError(f"geo-api returned {status}")
    raise GeoError("geo-api: too many retries")
