from __future__ import annotations

import dataclasses
import os
from dataclasses import dataclass, field

_CASTERS = {"int": int, "float": float, "str": str, "bool": lambda s: s.strip().lower() in ("1", "true", "yes", "on"), "list[str]": lambda s: [x.strip() for x in s.split(",") if x.strip()]}


@dataclass
class Settings:
    dry_run: bool = True
    workers: int = 4
    source_dir: str = "/data/in"
    sample_rate: float = 1.0
    skip_validation: bool = False
    tables: list[str] = field(default_factory=lambda: ["events"])


def from_env(env=None) -> Settings:
    env = os.environ if env is None else env
    s = Settings()
    for f in dataclasses.fields(Settings):
        raw = env.get("INGEST_" + f.name.upper())
        if raw is None or raw == "":
            continue
        setattr(s, f.name, _CASTERS[f.type](raw))
    return s
