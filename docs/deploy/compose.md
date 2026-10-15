# Docker Compose

From a clone of this repository:

```bash
docker compose up -d --build
curl -sf localhost:3000/readyz     # {"ok":true}
```

Open http://localhost:3000. The port is published on `127.0.0.1` only, so only this machine can reach it. A reverse proxy on the same host, or changing the binding in `docker-compose.yml` (for example to `"3000:3000"`), exposes it to other machines: set up proxy identity or tokens first. Data lives in the `bab-data` volume (`/data` in the container). `docker compose down -v` removes it.

With a bind mount instead of the named volume, give the folder to the container user first: `chown -R 100:101 ./data`.

## Open mode

This file sets no identity and no tokens, so BAB runs **open**: anyone who can reach port 3000 (this machine, unless you change the binding) can read and write, and agent calls assert who they are. BAB logs a warning at startup. That is fine for a local trial. Do not expose this port to a network you do not trust.

## Add proxy identity

Put an authenticating proxy in front (see [oauth2-proxy.md](oauth2-proxy.md)) and add to the `bab` service:

```yaml
    environment:
      BAB_PUBLIC_ORIGIN: https://bab.example.com
      BAB_TRUST_PROXY: "1"
      BAB_TRUST_PROXY_IDENTITY: "1"
      BAB_PROXY_SECRET: change-me-long-random
```

## Add tokens

```yaml
    environment:
      BAB_API_TOKENS: "tokenA=alice@example.com,tokenB=bob@example.com"
```

Agents then send `Authorization: Bearer <token>`. Keep real tokens in a file and set `BAB_API_TOKENS_FILE` instead. All settings: [../configuration.md](../configuration.md).
