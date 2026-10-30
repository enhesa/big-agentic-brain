# Key-value store

BAB keeps a small key-value store so agents can coordinate across sessions, machines and colleagues: a lock so only one agent works on a repo at a time, a counter, a progress marker, or a shared pace for bulk work such as pushes and pull requests. Every operation is atomic. It works with the BAB identity agents already have.

## What not to store

Never secrets, credentials or personal data. The store is for short-lived coordination state only. Keys in a shared namespace are readable by everyone with a BAB identity.

Each value is checked with the same redaction rules as memories and messages. A value that holds a password, token, key, connection string, an outside email address, a phone, card, bank account or national ID number is refused. The answer names the kind of thing found, never the value. This catches mistakes, not someone set on getting a secret past it.

The store is not storage. Every key has a time-to-live, and a crash can lose the last 30 seconds of writes.

## Keys and namespaces

A key is lowercase letters, digits, `.`, `_`, `-` and `/`, at most 200 characters after its namespace, with no empty, `.` or `..` segments. A key that redaction would change (a token, a long number such as a card or phone number) is refused: keys show in shared lists and in the audit log. An identity that contains a slash cannot use the store, so one person's space can never be a prefix of another's. Keys are taken exactly as given: BAB does not lowercase or decode them, so `U/...`, `%2e%2e` or `shared/Build/...` are refused, never mapped somewhere else.

- `u/<your id>/...` is your own space. The API never lets another identity read, list or change it, but that is only as strong as BAB's identity (see [Identity](#identity)): treat it as private to whoever BAB believes you are, not as secret. A key with no namespace goes there: `build/lock` means `u/<your id>/build/lock`. Maintainers can purge it.
- `shared/<name>/...` is open to everyone with a BAB identity, but only for the names in `BAB_KV_SHARED_NAMESPACES` (default `bitbucket-push`). Any other `shared/` name is refused. `get` and `list` there show who holds each lock (their BAB id, an email address), so everyone sees who works on what.
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
| `throttle` | `key`, `minIntervalSeconds` (0.1 to 3600 and at most the namespace's TTL cap, must match the key's) | `waitSeconds`, `slotAt` and the key's `minIntervalSeconds` |
| `lock` | `key`, `ttlSeconds` | `acquired: true` with a `token`, or `acquired: false` with the `holder` and the TTL left |
| `unlock` | `key`, `token` | `released: true`, or `released: false` with `reason` |
| `renew` | `key`, `token`, `ttlSeconds` | `renewed: true` and the new TTL |
| `force_delete` | `key` (maintainers only) | `deleted`, and the `kind` and `writer` of what was removed |
| `purge` | `user` (maintainers only) | how many keys were `deleted` |

- `cas` and `delete` compare values as JSON, so `{"a":1,"b":2}` equals `{"b":2,"a":1}`.
- An answer like `set: false` or `acquired: false` is a normal outcome, not an error.

### Throttle

`throttle` books the next slot on a pace that everyone with the same key shares. The slot is `max(now, last slot + minIntervalSeconds)`. The caller sleeps `waitSeconds`, then does its work. Booking is atomic, so 50 agents calling at once get 50 slots, one interval apart. The interval is fixed by whoever creates the key: a call with another interval gets 409 and names the key's interval, so nobody can stretch the pace for others or skip it. One person holds at most 4 future slots on one key (429 after that), and no slot is booked more than an hour ahead, or further than the namespace's TTL cap (429). An interval longer than the namespace's TTL cap is refused with 400. A throttle key ends at most one TTL cap after it was created, however often it is called, and the next caller starts it afresh with their own interval. Someone who creates a shared throttle key with a slow pace holds that key name for at most that long (an hour by default); pick another key meanwhile, or ask a maintainer to `force_delete` it. Example for pull requests across all agents: `bab_kv action=throttle key=shared/bitbucket-push/pull-requests minIntervalSeconds=30`.

### Lock

`lock` takes a lock nobody holds and returns a random `token`. Keep it: `unlock` and `renew` need it, and nothing else releases the lock before its TTL ends. Pick a TTL longer than the job and `renew` for long jobs, so a crashed holder never blocks anyone for longer than the TTL. A lock is not re-entrant: taking it again answers `acquired: false`.

Locks and throttles are their own kinds of key. Their token is never shown, not even to the holder after `lock` answers. `set`, `cas` and `incr` cannot overwrite them, and in a shared namespace `delete` cannot remove them. In your own space you can delete them. In a shared namespace a maintainer can remove any of them with `force_delete`.

## Limits

| Limit | Default | Setting |
| --- | --- | --- |
| Size of one value (as JSON) | 64 KB | `BAB_KV_MAX_VALUE_BYTES` (at most 256 KB) |
| Keys per person, and per shared namespace | 1000 | `BAB_KV_MAX_KEYS_PER_USER` |
| Keys one person may hold inside each shared namespace | 50 | `BAB_KV_SHARED_MAX_KEYS_PER_USER` |
| Bytes one person may hold inside each shared namespace | 512 KB | `BAB_KV_SHARED_MAX_BYTES_PER_USER` |
| Bytes per person, and per shared namespace (keys plus values) | 4 MB | `BAB_KV_MAX_BYTES_PER_USER` |
| Bytes in the whole store | 20 MB | `BAB_KV_MAX_TOTAL_BYTES` (at most 256 MB) |
| Time-to-live | 1 second to 24 hours, required | `BAB_KV_MAX_TTL_SECONDS` (at most 7 days) |
| Time-to-live in a shared namespace | 1 hour at most | `BAB_KV_SHARED_MAX_TTL_SECONDS` |
| Key length after the namespace | 200 characters | fixed |
| Calls per person | 60 a minute, 20 at once | fixed |
| Throttle interval, and how far ahead a slot may be booked | 1 hour, or the namespace's TTL cap when shorter | fixed |
| Future throttle slots one person may hold on one key | 4 | fixed |
| Shared namespaces | `bitbucket-push` | `BAB_KV_SHARED_NAMESPACES` (`none` for none) |
| Switch | on | `BAB_KV` |

- A full store answers 507 and says whose limit it hit. A key in a shared namespace counts against that namespace and against the person who wrote it last (a lock: its holder; a throttle: whoever created it), so one person cannot fill a namespace for everyone.
- Values are nested at most 64 levels deep. A number that `incr` would store is checked like any other value.
- TTLs run on the server's wall clock. A clock that jumps forward ends locks early; one that jumps back keeps them longer.
- Expired keys are removed when they are touched, and by a sweep every minute.
- Too many calls answer 429. The general API limit applies too.

## Identity

The store serves only a caller whose identity BAB remembers or checks, the same rule as the [file store](files.md#identity):

- a device the BAB plugin set up (`X-Bab-Device`, bound with `bab_identify`),
- the sign-in proxy (`BAB_TRUST_PROXY_IDENTITY`),
- an API token bound to that person (`BAB_API_TOKENS` entry `token=email`).

A caller identified only by `X-Bab-Actor-*` headers, or by `bab_identify` on an MCP connection with no device, gets 403 on every action. A connection-only caller is told to call `bab_identify` once so its device is linked. The owner of a key always comes from that identity, never from the request body or query. `BAB_KV_ALLOW_DECLARED=1` lifts the rule for local development only; BAB warns at startup when it is on.

A device is still the person's own word, remembered: `bab_identify` binds a new device secret to the address it is given, and can rebind a device that was someone else's. A device is not proof of who someone is. The rule above stops header spoofing, not a caller who identifies as someone else on purpose; that caller could then read and change the other person's own space. BAB only makes it visible: when a new device is connected as a person who already has another device or a linked browser, that person's sessions are told once. The first device of someone with nothing else cannot be noticed this way. Where that matters, put BAB behind the sign-in proxy or give people tokens bound to them (see [Files](files.md#identity) and [Operating BAB](operations.md)).

## Maintainers

A person in `BAB_MAINTAINERS` can clear a squatted shared namespace:

- `force_delete` removes any key in a shared namespace (or in their own space), a lock or throttle included.
- `purge` removes every key one person wrote or holds in the shared namespaces, and every key in their own space.

Both are audited (`kv_force_delete`, `kv_purge`) with the maintainer, the key or person, and what was removed.

The per-person shared limits stop one identity, not many: each new identity costs one `bab_identify`, so someone can still fill a namespace under several, and cleanup is one `purge` per identity. Maintainer status rests on the same device identity (see [Identity](#identity)).

## Atomicity and replicas

The store is one map in memory in the BAB process. No operation waits for anything between its first read and its last write, so on Node's single thread no other request can run in the middle of one. That makes `set` with `ifAbsent`, `cas`, `incr`, `throttle` and `lock` atomic.

This holds only while one BAB process serves the data. BAB runs as one replica (see [Operating BAB](operations.md)). If `BAB_REPLICAS` is set above 1, the store refuses every call with 503 and BAB warns at startup. Two processes would each have their own map, and two agents could both get the same lock.

The setting is the operator's word, so BAB also checks. The first process to use the store writes a lease, `DATA_DIR/kv.lease` (host, pid, a random instance id), and refreshes it every 10 seconds. Another process on the same data refuses the store with 503 while that lease is fresh (younger than 30 seconds) and its holder is alive. A lease that has not been refreshed for 30 seconds (a crashed process) is taken over, and so is one from the same host whose process is gone (a container restart). A clean shutdown removes the lease, so the next pod starts at once. Limits:

- Two processes that start in the same moment can both write the lease; the loser notices at its next heartbeat (within 10 seconds) and stops serving the store.
- After a crash, a new process on another host waits up to 30 seconds before it serves the store.
- In a rolling update the new pod refuses the store until the old one is gone. BAB's chart uses `Recreate` with a ReadWriteOnce volume, so pods do not overlap.
- A process that loses the lease to another answers 503 for every call until it restarts; it never takes the lease back.
- A process that cannot write `DATA_DIR/kv.lease` (an unwritable or missing volume) answers 503 saying so, and tries again on the next call.
- The lease only works when both processes see the same `DATA_DIR`. Two replicas with separate volumes do not see each other: keep `BAB_REPLICAS` honest.

## Restarts and snapshot

Every 30 seconds, when something changed, BAB writes the live keys to `DATA_DIR/kv-snapshot.json`. It also writes it when it shuts down (SIGTERM). It writes a temporary file, flushes it to disk and renames it, so the file is never half written. Only the process that holds the lease writes it. At start, the first call loads the snapshot and checks every entry as strictly as a new write: it drops keys that expired meanwhile, keys outside an allowed namespace or with a bad name, expiry times that are not finite or exceed the TTL cap, values that are too large, too deeply nested or look like a secret or personal data, malformed locks and throttles (including a throttle interval over the TTL cap, a slot booked further ahead than a new booking may be, or one that would outlive one TTL cap from its creation), duplicates, and entries over a limit. It logs how many it dropped. Locks keep their holder and token across a restart, and throttles carry on from their last slot.

A crash loses at most the last 30 seconds of writes. Every key has a TTL, so locks and throttle slots heal on their own. The snapshot holds lock tokens and values: keep it as private as the rest of the data volume. A broken snapshot is logged and BAB starts with an empty store.

## Audit

Every `set`, `cas`, `incr`, `delete`, `throttle`, `lock`, `unlock`, `renew`, `force_delete` and `purge` writes an audit row (`kv_set`, `kv_lock`, ...) with the person, the key and the result, such as `set`, `exists`, `swapped`, `mismatch`, `acquired`, `held`, `token_mismatch` or `interval_mismatch`. A write whose audit row cannot be written is undone and the call fails, so nothing changes without its audit row. REST and MCP calls are both recorded with `via` `mcp`, as every agent route in BAB does. Values and tokens are never written to the audit log. Reads write no `kv_` row; like every API call, a REST read is recorded only as a request (method and path).
