from ingest.settings import from_env


def plan(env=None):
    s = from_env(env)
    actions = []
    for table in s.tables:
        actions.append(("validate", table) if not s.skip_validation else ("skip-validate", table))
        actions.append(("write", table) if not s.dry_run else ("log-only", table))
    return actions
