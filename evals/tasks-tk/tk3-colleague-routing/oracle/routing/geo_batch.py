"""Batch address lookups for route planning, via geo-api (the platform team's internal geocoding service)."""
import json
import time


class GeoError(Exception):
    pass


class QuotaExceeded(GeoError):
    pass


MAX_RETRIES = 3


def lookup(addr: str, transport, sleep=time.sleep) -> dict:
    for attempt in range(MAX_RETRIES + 1):
        status, headers, body = transport(addr)
        if status == 200:
            return json.loads(body)
        if status == 503:
            raise QuotaExceeded("geo-api: daily quota exhausted")
        if status == 429:
            if attempt == MAX_RETRIES:
                break
            sleep(float(headers.get("Retry-After-Ms", 1000)) / 1000)
            continue
        raise GeoError(f"geo-api returned {status}")
    raise GeoError("geo-api: too many retries")
