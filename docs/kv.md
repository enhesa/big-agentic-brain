# Key-value store

BAB keeps a small key-value store so agents can coordinate across sessions, machines and colleagues: a lock so only one agent works on a repo at a time, a counter, a progress marker, or a shared pace for bulk work such as pushes and pull requests. Every operation is atomic. It works with the BAB identity agents already have.

## What not to store

Never secrets, credentials or personal data. The store is for short-lived coordination state only. Keys in a shared namespace are readable by everyone with a BAB identity.

Each value is checked with the same redaction rules as memories and messages. A value that holds a password, token, key, connection string, an outside email address, a phone, card, bank account or national ID number is refused. The answer names the kind of thing found, never the value. This catches mistakes, not someone set on getting a secret past it.

The store is not storage. Every key has a time-to-live, and a crash can lose the last 30 seconds of writes.

## Keys and namespaces

A key is lowercase letters, digits, `.`, `_`, `-` and `/`, at most 200 characters after its namespace, with no empty, `.` or `..` segments. A key that redaction would change (a token, a long number such as a card or phone number) is refused: keys show in shared lists and in the audit log. An identity that contains a slash cannot use the store, so one person's space can never be a prefix of another's. Keys are taken exactly as given: BAB does not lowercase or decode them, so `U/...`, `%2e%2e` or `shared/Build/...` are refused, never mapped somewhere else.

- `u/<your id>/...` is yours alone. Nobody else can read, list or change it. A key with no namespace goes there: `build/lock` means `u/<your id>/build/lock`.
- `shared/<name>/...` is open to everyone with a BAB identity, but only for the names in `BAB_KV_SHARED_NAMESPACES` (default `bitbucket-push`). Any other `shared/` name is refused.
- Any other `u/<id>/` is refused with 403. There is no way to list every shared namespace or anyone else's keys.

## Operations

With the plugin or any MCP client, the `bab_kv` tool takes an `action`. The REST API takes the same fields: `POST /api/kv` with `{ "action": ..., ... }`, plus `GET /api/kv?key=<key>` to read one key and `GET /api/kv?prefix=<prefix>` to list.

| Action | Fields | Answer |
| --- | --- | --- |
| `get` | `key` | `found`, `kind`, `value` (for a value), `ttlSeconds` left, `holder` (for a lock), `slotAt` (for a throttle) |
| `set` | `key`, `value` (any JSON), `ttlSeconds`, `ifAbsent`, `ifExists` | `set: true`, or `set: false` with `reason` `exists` or `missing` |
| `cas` | `key`, `expected`, `value`, `ttlSeconds` | `swapped: true`, or `swapped: false` with the `current` value |
| `incr` | `key`, `by` (whole number, default 1), `ttlSeconds` when it creates the key | the new `value`; the TTL stays as it was |
| `delete` | `key`, optional `expected` | `deleted: true`, or `deleted: false` with `reason` |
| `list` | `prefix` (default your own space) | keys with their kind and TTL left, never values; your usage |
| `throttle` | `key`, `minIntervalSeconds` (0.1 to 3600) | `waitSeconds` and `slotAt` |
| `lock` | `key`, `ttlSeconds` | `acquired: true` with a `token`, or `acquired: false` with the `holder` and the TTL left |
| `unlock` | `key`, `token` | `released: true`, or `released: false` with `reason` |
| `renew` | `key`, `token`, `ttlSeconds` | `renewed: true` and the new TTL |

- `cas` and `delete` compare values as JSON, so `{"a":1,"b":2}` equals `{"b":2,"a":1}`.
- An answer like `set: false` or `acquired: false` is a normal outcome, not an error.

### Throttle

`throttle` books the next slot on a pace that everyone with the same key shares. The slot is `max(now, last slot + minIntervalSeconds)`. The caller sleeps `waitSeconds`, then does its work. Booking is atomic, so 50 agents calling at once get 50 slots, one interval apart. A slot more than an hour ahead is refused (429). Example for pull requests across all agents: `bab_kv action=throttle key=shared/bitbucket-push/pull-requests minIntervalSeconds=30`.

### Lock

`lock` takes a lock nobody holds and returns a random `token`. Keep it: `unlock` and `renew` need it, and nothing else releases the lock before its TTL ends. Pick a TTL longer than the job and `renew` for long jobs, so a crashed holder never blocks anyone for longer than the TTL. A lock is not re-entrant: taking it again answers `acquired: false`.

Locks and throttles are their own kinds of key. Their token is never shown, not even to the holder after `lock` answers. `set`, `cas` and `incr` cannot overwrite them, and in a shared namespace `delete` cannot remove them. In your own space you can delete them.

## Limits

| Limit | Default | Setting |
| --- | --- | --- |
| Size of one value (as JSON) | 64 KB | `BAB_KV_MAX_VALUE_BYTES` (at most 256 KB) |
| Keys per person, and per shared namespace | 1000 | `BAB_KV_MAX_KEYS_PER_USER` |
| Bytes per person, and per shared namespace (keys plus values) | 4 MB | `BAB_KV_MAX_BYTES_PER_USER` |
| Bytes in the whole store | 20 MB | `BAB_KV_MAX_TOTAL_BYTES` (at most 256 MB) |
| Time-to-live | 1 second to 24 hours, required | `BAB_KV_MAX_TTL_SECONDS` (at most 7 days) |
| Key length after the namespace | 200 characters | fixed |
| Calls per person | 60 a minute, 20 at once | fixed |
| Throttle interval, and how far ahead a slot may be booked | 1 hour | fixed |
| Shared namespaces | `bitbucket-push` | `BAB_KV_SHARED_NAMESPACES` (`none` for none) |
| Switch | on | `BAB_KV` |

- A full store answers 507 and says whose limit it hit. A key in a shared namespace counts against that namespace, not against the person who wrote it.
- Expired keys are removed when they are touched, and by a sweep every minute.
- Too many calls answer 429. The general API limit applies too.

## Identity

The store serves only a caller whose identity BAB remembers or checks, the same rule as the [file store](files.md#identity):

- a device the BAB plugin set up (`X-Bab-Device`, bound with `bab_identify`),
- the sign-in proxy (`BAB_TRUST_PROXY_IDENTITY`),
- an API token bound to that person (`BAB_API_TOKENS` entry `token=email`).

A caller identified only by `X-Bab-Actor-*` headers, or by `bab_identify` on an MCP connection with no device, gets 403 on every action. A connection-only caller is told to call `bab_identify` once so its device is linked. The owner of a key always comes from that identity, never from the request body or query. `BAB_KV_ALLOW_DECLARED=1` lifts the rule for local development only; BAB warns at startup when it is on.

## Atomicity and replicas

The store is one map in memory in the BAB process. No operation waits for anything between its first read and its last write, so on Node's single thread no other request can run in the middle of one. That makes `set` with `ifAbsent`, `cas`, `incr`, `throttle` and `lock` atomic.

This holds only while one BAB process serves the data. BAB runs as one replica (see [Operating BAB](operations.md)). If `BAB_REPLICAS` is set above 1, the store refuses every call with 503 and BAB warns at startup. Two processes would each have their own map, and two agents could both get the same lock.

## Restarts and snapshot

Every 30 seconds, when something changed, BAB writes the live keys to `DATA_DIR/kv-snapshot.json`. It also writes it when it shuts down (SIGTERM). It writes a temporary file and renames it, so the file is never half written. At start, the first call loads the snapshot and drops keys that expired meanwhile. Locks keep their holder and token across a restart, and throttles carry on from their last slot.

A crash loses at most the last 30 seconds of writes. Every key has a TTL, so locks and throttle slots heal on their own. The snapshot holds lock tokens and values: keep it as private as the rest of the data volume. A broken snapshot is logged and BAB starts with an empty store.

## Audit

Every `set`, `cas`, `incr`, `delete`, `throttle`, `lock`, `unlock` and `renew` writes an audit row (`kv_set`, `kv_lock`, ...) with the person, the key and the result, such as `set`, `exists`, `swapped`, `mismatch`, `acquired`, `held` or `token_mismatch`. Values and tokens are never written to the audit log. Reads write no `kv_` row; like every API call, a REST read is recorded only as a request (method and path).
