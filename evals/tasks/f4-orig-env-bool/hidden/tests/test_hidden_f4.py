import unittest
from notify import config
class HiddenTest(unittest.TestCase):
    def test_bool_spellings(self):
        for raw, exp in [("true", True), ("True", True), ("1", True), ("yes", True), ("on", True),
                         ("false", False), ("False", False), ("0", False), ("no", False), ("off", False)]:
            self.assertIs(config.load(env={"NOTIFY_DEBUG": raw})["debug"], exp, raw)
    def test_ints_and_strings(self):
        cfg = config.load(env={"NOTIFY_BATCH_SIZE": "10", "NOTIFY_GATEWAY_URL": "x"})
        self.assertEqual((cfg["batch_size"], cfg["gateway_url"]), (10, "x"))
