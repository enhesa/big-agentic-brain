from geo.cache import DiskCache


class GeoClient:
    def __init__(self, fetch, cache_dir):
        self.fetch = fetch          # callable(address) -> dict, hits the paid API
        self.cache = DiskCache(cache_dir)
        self.api_calls = 0

    def lookup(self, address):
        key = "geocode:v1:" + " ".join(address.lower().split())
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        self.api_calls += 1
        value = self.fetch(address)
        self.cache.set(key, value)
        return value
