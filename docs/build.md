# Build

```bash
git clone https://github.com/enhesa/big-agentic-brain.git
cd big-agentic-brain
docker build --build-arg BASE_IMAGE=node:24-alpine -t <registry>/bab:1.0.0 .
docker push <registry>/bab:1.0.0
```

`BASE_IMAGE` can point at a registry mirror of `node:24-alpine`. Dependencies install at build time; the running container needs no registry access.

## Runtime requirements

- **One replica.** Rate limits, live events and the database are per process.
- **Local block storage for `/data`.** The SQLite database uses a write-ahead log. Do not use NFS, SMB or Azure Files.
- Port `3000`.
- Probes: `GET /healthz` (liveness) and `GET /readyz` (readiness).
- SIGTERM is handled: open streams close and the process exits within about 2 seconds.
- Runs as the non-root user `app` (UID 100). Give `/data` to that user, or run with a securityContext whose fsGroup matches. The app creates the database file with mode 0600, so the volume must be owned by UID 100.
- Settings: [configuration.md](configuration.md).
