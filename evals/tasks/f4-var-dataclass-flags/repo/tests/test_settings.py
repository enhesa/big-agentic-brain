import unittest

from ingest.settings import from_env
from ingest.worker import plan


class SettingsTest(unittest.TestCase):
    def test_defaults(self):
        s = from_env({})
        self.assertTrue(s.dry_run)
        self.assertEqual(s.workers, 4)

    def test_live_run(self):
        # The nightly job is configured like this; it must actually write and validate.
        env = {"INGEST_DRY_RUN": "0", "INGEST_SKIP_VALIDATION": "False", "INGEST_TABLES": "events, users"}
        self.assertEqual(plan(env), [("validate", "events"), ("write", "events"),
                                     ("validate", "users"), ("write", "users")])

    def test_workers(self):
        self.assertEqual(from_env({"INGEST_WORKERS": "8"}).workers, 8)
