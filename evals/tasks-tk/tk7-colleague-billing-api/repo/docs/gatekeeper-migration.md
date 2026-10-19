# Migrating a service to Gatekeeper tokens (platform team)

Gatekeeper replaced the old auth.acme.example tokens on 2026-10-01. The gateway still checks the
signature; each service checks the claims. Claims in Gatekeeper tokens:

- `iss`: always `https://gatekeeper.internal`
- `aud`: `svc:<service-name>`, e.g. `svc:billing`. A single string, or a list when the token is
  valid for several services.
- `scp`: the granted scopes as ONE space-separated string, e.g. `"billing.read reports.read"`
  (the old tokens had a `scopes` list). Match whole scope names.
- `exp` / `nbf`: Unix seconds. Gatekeeper hosts' clocks can drift: accept up to 120 seconds of
  clock skew on both.
