from notify import config


def pick_gateway(cfg=None):
    cfg = cfg or config.load()
    if cfg["sandbox"]:
        return "https://sandbox.gw.example.com"
    return cfg["gateway_url"]
