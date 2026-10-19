import json
import os

DEFAULTS = {"sandbox": True, "debug": False, "max_retries": 3,
            "gateway_url": "https://sandbox.gw.example.com", "batch_size": 50}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(env=None, path=None):
    """settings.json values, then NOTIFY_<KEY> env overrides cast to the default's type."""
    env = os.environ if env is None else env
    cfg = dict(DEFAULTS)
    with open(path or os.path.join(ROOT, "settings.json")) as fh:
        cfg.update(json.load(fh))
    for key, default in DEFAULTS.items():
        raw = env.get("NOTIFY_" + key.upper())
        if raw is not None:
            if isinstance(default, bool):
                cfg[key] = raw.strip().lower() in ("1", "true", "yes", "on")
            else:
                cfg[key] = type(default)(raw)
    return cfg
