import json
import os
import time


class DiskCache:
    """Tiny JSON-file cache. One file per key, safe to share across worker processes."""

    def __init__(self, directory, ttl=7 * 86400):
        self.dir = directory
        self.ttl = ttl
        os.makedirs(directory, exist_ok=True)

    def _path(self, key):
        return os.path.join(self.dir, "%016x.json" % (hash(key) & 0xFFFFFFFFFFFFFFFF))

    def get(self, key):
        try:
            with open(self._path(key)) as fh:
                entry = json.load(fh)
        except (OSError, ValueError):
            return None
        if entry.get("key") != key or time.time() - entry["at"] > self.ttl:
            return None
        return entry["value"]

    def set(self, key, value):
        tmp = self._path(key) + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"key": key, "value": value, "at": time.time()}, fh)
        os.replace(tmp, self._path(key))
