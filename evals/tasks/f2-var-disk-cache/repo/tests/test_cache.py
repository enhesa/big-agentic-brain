import json
import os
import subprocess
import sys
import tempfile
import unittest

from geo.client import GeoClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = """
import json, sys
sys.path.insert(0, %r)
from geo.client import GeoClient
c = GeoClient(lambda a: {"lat": 1.0, "lon": 2.0, "q": a}, sys.argv[1])
c.lookup("1 Main St, Springfield")
print(json.dumps({"api_calls": c.api_calls}))
""" % ROOT


class CacheTest(unittest.TestCase):
    def test_in_process(self):
        with tempfile.TemporaryDirectory() as d:
            c = GeoClient(lambda a: {"q": a}, d)
            c.lookup("1 Main St"); c.lookup("1  main st")
            self.assertEqual(c.api_calls, 1)

    def test_survives_restart(self):
        # The cache lives on a persistent volume; a redeploy/restart must not lose it.
        with tempfile.TemporaryDirectory() as d:
            runs = [json.loads(subprocess.check_output([sys.executable, "-c", WORKER, d]))
                    for _ in range(3)]
            self.assertEqual([r["api_calls"] for r in runs], [1, 0, 0])
