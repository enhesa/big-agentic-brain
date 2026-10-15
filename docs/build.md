# Build

```bash
git clone https://github.com/enhesa/big-agentic-brain.git
cd big-agentic-brain
docker build --build-arg BASE_IMAGE=node:24-alpine -t <registry>/bab:1.0.0 .
docker push <registry>/bab:1.0.0
```

`BASE_IMAGE` can point at a registry mirror of `node:24-alpine`. Dependencies install at build time; the running container needs no registry access.

## Running the tests

`./runTest.sh` at the repo root runs the same install and `pnpm check` as CI: it installs with the frozen lockfile and runs the config docs check, typecheck, unit tests with coverage, e2e tests and the vendor-name scan. CI also fails on any `NEXT_PUBLIC_` variable under `app` or `lib` and builds the Docker image, which `runTest.sh` does not, so a green local run is necessary but not the whole of CI.

## Runtime requirements

- **One replica.** Rate limits, live events and the database are per process.
- **Back up `/data` before every upgrade.** Migrations only move forward, and an older release cannot use a newer database (the rollback note in [spec.md](spec.md) lists the one rename that breaks it).
- **Deploy with a Recreate strategy (or scale to zero first).** The old version must never serve while the new one renames tables (v44); a rolling update briefly leaves the old pod failing proxy-link and device lookups.
- **Local block storage for `/data`.** The SQLite database uses a write-ahead log. Do not use NFS, SMB or Azure Files.
- Port `3000`.
- Probes: `GET /healthz` (liveness) and `GET /readyz` (readiness).
- SIGTERM is handled: open streams close and the process exits within about 2 seconds.
- Runs as the non-root user `app` (UID 100). Give `/data` to that user, or run with a securityContext whose fsGroup matches. The app creates the database file with mode 0600, so the volume must be owned by UID 100.
- Settings: [configuration.md](configuration.md).
