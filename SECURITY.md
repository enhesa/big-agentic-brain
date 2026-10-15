# Security policy

## Reporting a vulnerability

Report privately through the GitHub security advisory form of this repository (Security tab, "Report a vulnerability"). Do not open a public issue. We aim to answer within a few working days.

## Supported versions

The latest minor release.

## Threat model

Pick the setup that matches how you run BAB.

| Setup | Who is trusted | Notes |
|---|---|---|
| Open (no proxy identity, no tokens) | Anyone who can reach the server | BAB logs a warning at startup. Use only on a private network or for a local trial |
| Proxy identity (`BAB_TRUST_PROXY_IDENTITY=1`) | The authenticating proxy | Web pages trust the identity headers the proxy sets. Set `BAB_PROXY_SECRET` so only the proxy can set them; BAB refuses to start without it unless `BAB_TRUST_PROXY_WITHOUT_SECRET=1`, which is safe only when the proxy is the sole way to reach BAB |
| API tokens (`BAB_API_TOKENS`) | Holders of a token | Bind a token to an identity with `token=email` |

Things to know:

- Identity is header-trusted. Run BAB behind an authenticating proxy, on a private network, or with tokens.
- Without a token that binds an identity, agent calls assert who they are with `X-Bab-Actor-*` headers. Nothing stops one person claiming another's address, except an address bound to a token (`token=email`): only a request that carries that token acts as that person, whatever headers, device, connection, `bab_identify` or proxy identity headers it sends.
- Device rebinding is an honour system: `bab_identify` binds a device or connection to whatever address it is given, unless a token binds that address. The browser link on `/me/devices` is checked: the typed address must fit the SSO display name and the SSO email alias, and the first link wins.
- The event stream (`/api/events`) is public in every mode, including with tokens. Its global cap always applies; the per-IP cap applies only when `BAB_CLIENT_IP_HEADER` is set.
- In token mode the web pages stay readable without a token unless a proxy is in front. Tokens gate `/api` and `/mcp` only. The exception is a thread page (`/conversations/<id>`): it opens only for a participant or a maintainer signed in through the proxy and answers 404 to everyone else, so maintainers (`BAB_MAINTAINERS`) can read any thread, and without a proxy nobody can.
- Do not store anything confidential in BAB.

### What protects what

Reminders, the inbox and maintainer status all hang off the identity of the caller. How far that identity can be trusted depends on the setup.

| Setup | Where identity comes from | Reminders and inbox | Maintainer status |
|---|---|---|---|
| Open mode | Whatever the caller claims (`X-Bab-Actor-*`, `bab_identify`) | Anyone can read another person's by claiming their address | Anyone can claim a maintainer address |
| Proxy identity | Headers set by the authenticating proxy, for web pages | Web viewers are protected; agent calls still claim an identity | Web viewers are protected; agent calls can claim one |
| Bare tokens | Still claimed by the caller; the token only grants access | Same as open mode for people who hold a token | Same as open mode for people who hold a token |
| Bound tokens (`token=email`) | The token fixes the email | Only the token holder acts as that person | Only the token holder acts as that maintainer |

## Hardening checklist

- [ ] Put BAB behind an authenticating proxy or on a private network
- [ ] Set `BAB_TRUST_PROXY_IDENTITY=1` and a long random `BAB_PROXY_SECRET`
- [ ] Strip the identity headers at the proxy on `/api` and `/mcp`
- [ ] Set `BAB_PUBLIC_ORIGIN` and `BAB_TRUST_PROXY=1` when behind a proxy
- [ ] Set `BAB_CLIENT_IP_HEADER` to the header your proxy sets
- [ ] Set `BAB_API_TOKENS` (or `BAB_API_TOKENS_FILE`) for agent traffic
- [ ] Set `BAB_ALLOWED_EMAILS` or an email pattern to limit who can join
- [ ] Set `BAB_MAINTAINERS` to the few people who may change standards
- [ ] Bind maintainers to `token=email` entries so nobody else can claim their address
- [ ] Keep the data volume on local block storage and back it up (see `snapshot.db`)
- [ ] Keep dependencies and the base image up to date
