# Operating BAB

How to run BAB safely: who can act as whom, and how to deploy, back up and upgrade it. The [README](../README.md) has the quick start.

## Trust model

BAB works like a team wiki: identity is trusted unless you configure otherwise. Choose the setup that matches where it runs.

| Setup | What it means |
|---|---|
| **Open** (default) | Anyone who can reach the instance can act as anyone. Suitable on a laptop or a private network. BAB logs a warning at startup. |
| **Behind a sign-in proxy** (`BAB_TRUST_PROXY_IDENTITY=1` plus either `BAB_PROXY_SECRET` or, if the proxy is the only way in, `BAB_TRUST_PROXY_WITHOUT_SECRET=1`) | Web viewers are who the proxy says. Agent calls still self-identify, so keep `/api` and `/mcp` on the private network. |
| **Bearer tokens** (`BAB_API_TOKENS`) | `/api` and `/mcp` require a token. A `token=email` entry binds the identity; a bare token only gates access. |

BAB has no sign-in screen of its own. It works behind a proxy such as oauth2-proxy. Identity on each call resolves in this order:

1. The sign-in proxy, on web pages.
2. A bound token.
3. A remembered device (`X-Bab-Device`).
4. A remembered MCP connection (`Mcp-Session-Id`).
5. The self-asserted `X-Bab-Actor-Email` and `X-Bab-Actor-Name` headers.

Tokens can also come from a file (`BAB_API_TOKENS_FILE`). With a bound token only the token holder acts as that person. In the other modes identity is self-asserted. `BAB_MAINTAINERS` sets who can pin house rules, set feedback status and decide on flagged standards. On a shared network also review `BAB_PUBLIC_ORIGIN`, `BAB_TRUST_PROXY` and `BAB_CLIENT_IP_HEADER`.

The event stream (`/api/events`) is public in every mode, is rate-limited and carries memory titles. Keep confidential material out of BAB. Memories are readable by everyone who can reach it. Reminders and messages are tied to an identity, which in open mode anyone can claim. BAB masks secrets and, by default, email addresses by their shape before it writes. This is best effort, not a guarantee. Most API and tool calls and the main web pages go to an audit log, which is kept 365 days by default (`BAB_AUDIT_RETENTION_DAYS`). The event stream, the API index, the MCP handshake and most hook calls are not audited. The database file has mode 0600. Use volume encryption from your platform. Threat model, hardening checklist and disclosure process: [SECURITY.md](../SECURITY.md). Report vulnerabilities through the private GitHub security advisory form. Supported versions: the latest minor release.

## Deploy and operate

- **Configuration**: every setting is an environment variable, listed in [docs/configuration.md](configuration.md) (generated from the code).
- **Docker Compose** quick start and hardening: [docs/deploy/compose.md](deploy/compose.md). **Behind oauth2-proxy**: [docs/deploy/oauth2-proxy.md](deploy/oauth2-proxy.md).
- **Build your own image** and push it to your registry: [docs/build.md](build.md). Any `node:24-alpine` compatible base image works through the `BASE_IMAGE` build argument. There is no published image yet.
- **Runtime shape**: one replica and a local block volume at `/data`. SQLite runs in write-ahead-log (WAL) mode. NFS, SMB and Azure Files are not supported. Health checks are `/healthz` and `/readyz`. BAB shuts down cleanly on SIGTERM and runs as a non-root user. Defaults: `DATA_DIR=/data`, `PORT=3000`, `HOSTNAME=0.0.0.0`.
- **Backups**: BAB keeps a consistent copy at `/data/snapshot.db`, made with SQLite's `VACUUM INTO`. It has mode 0600 like the database. It is refreshed at most every 20 hours while the instance is in use. Point a backup tool at it, running as the same user or as root. Built-in backups are on the roadmap.
- **Upgrades**: migrations run forward on startup. Back up before upgrading.
- **Limits**: 2000 requests a minute per identity, 1000 a minute per address for unknown callers and 3000 process-wide for anonymous MCP. POST endpoints accept an `Idempotency-Key`. Request bodies are capped at 1048576 bytes (`BAB_MAX_BODY_BYTES`), checked from `Content-Length` only.

## Scale

The design notes plan for 500 or more agents at a modest load, about 50,000 searches a day. A test with 5,000 memories, 500 users and 20,000 messages passes a nominal 40 ms search gate, scaled by machine speed. BAB runs as one replica on SQLite, so a restart is a short outage. Postgres and multi-replica support are on the [roadmap](../README.md#roadmap).
