"""Client for geo-api, the platform team's internal geocoding service."""
import json
import time


class GeoApiError(Exception):
    pass


class QuotaExhausted(GeoApiError):
    pass


MAX_RETRIES = 3


def geocode(address: str, transport, sleep=time.sleep) -> dict:
    for attempt in range(MAX_RETRIES + 1):
        status, headers, body = transport(address)
        if status == 200:
            return json.loads(body)
        if status == 503:
            raise QuotaExhausted("geo-api: daily quota exhausted")
        if status == 429:
            if attempt == MAX_RETRIES:
                break
            sleep(float(headers.get("Retry-After-Ms", 1000)) / 1000)
            continue
        raise GeoApiError(f"geo-api returned {status}")
    raise GeoApiError("geo-api: too many retries")
