"""Client for geo-api, the platform team's internal geocoding service."""
import json
import time


class GeoApiError(Exception):
    pass


class QuotaExhausted(GeoApiError):
    pass


MAX_ATTEMPTS = 10


def geocode(address: str, transport, sleep=time.sleep) -> dict:
    """Geocode `address`. `transport(address)` returns (status, headers, body)."""
    for _ in range(MAX_ATTEMPTS):
        status, headers, body = transport(address)
        if status == 200:
            return json.loads(body)
        if status in (429, 503):
            sleep(float(headers.get("Retry-After", 1)))
            continue
        raise GeoApiError(f"geo-api returned {status}")
    raise GeoApiError("geo-api: too many retries")
