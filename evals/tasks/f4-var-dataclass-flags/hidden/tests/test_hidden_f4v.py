import unittest
from ingest.settings import from_env
class HiddenTest(unittest.TestCase):
    def test_bools(self):
        for raw, exp in [("1", True), ("true", True), ("YES", True), ("on", True),
                         ("0", False), ("false", False), ("No", False), ("off", False)]:
            self.assertIs(from_env({"INGEST_DRY_RUN": raw}).dry_run, exp, raw)
    def test_float(self):
        self.assertEqual(from_env({"INGEST_SAMPLE_RATE": "0.25"}).sample_rate, 0.25)
