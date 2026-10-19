# Shipfast request signing (v1)

Excerpt from the Shipfast partner documentation, saved 2026-09-12.

Every API request and every webhook sent to Shipfast must carry the header

    Shipfast-Signature: t=<timestamp>,v1=<signature>

- `<timestamp>`: Unix time in whole seconds at which the request was signed.
- `<signature>`: lowercase hex HMAC-SHA256, keyed with your signing secret, over the string
  `<timestamp>.<raw request body>` (the timestamp, a literal dot, then the exact body bytes you send).

The legacy `X-Shipfast-Signature` header (an HMAC of the body alone) was switched off on 2026-09-01.
Requests that only carry it are rejected with 401 "signature verification failed".
Requests whose timestamp is more than 5 minutes old are rejected too.
