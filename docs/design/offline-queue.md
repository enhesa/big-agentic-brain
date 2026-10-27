# Design: offline queue and circuit breaker for the Claude Code plugin

Status: draft for review. Design only, no code. Builds on PR #71 (pause the poll after two timeouts) and PR #72 (`tool.check` auto-allow for BAB's tools), both merged in release 2.8.0.

## 1. Problem

BAB is reachable only on the company network or VPN. Off it:

- The curl hooks (`hooks.json`) fail silently after about 1 s (`--connect-timeout 1`). Fine.
- The inbox poll in `register.tsx` backs off from 30 s to 5 min. Fine.
- If Claude starts off the network, the MCP server never connects. The `bab_*` tools are absent for the whole session. A `bab_learn` the agent would have made is lost, and the agent often says nothing about it.
- Reconnecting the VPN does not bring the tools back. The person must run `/mcp` or restart.
- If the server drops mid-session, each BAB tool call waits up to `CALL_TIMEOUT_MS` (20 s) before it fails. On the desktop app a hung call can also look like a pending approval (the reason for #71).

Goal: off the network, BAB fails fast, says so plainly, keeps what is safe to keep, and sends it once, as the same person, when BAB is back. It must never send something the person did not mean to send, never send twice, and never lose something silently.

Non-goals: offline reads from a cache, offline messaging to colleagues, a local copy of the memory, changes to the curl hooks (see the note in 14; phase 5 revisits them).

## 2. Principles

1. Honest first. Every path tells the agent and the person "not in BAB yet" or "BAB is offline". No path pretends.
2. Queue only what is safe to send later. Everything else fails loudly.
3. A queued item is immutable. Only its state changes.
4. Replay is idempotent end to end. A timeout that actually succeeded must not duplicate.
5. Identity is checked at replay, not assumed.
6. Bounded in size, age and attempts. Nothing grows without limit.
7. No new secrets. The mod never holds the device secret. Replay goes through the plugin's own MCP connection.
8. Unknown means hold, not guess.

## 3. What is queued

| Tool and action | Queue? | Why |
| --- | --- | --- |
| `bab_learn` (new learning or practice) | Yes | The main loss today. The server redacts and checks duplicates at write. |
| `bab_learn` with `supersedes`, `kind: decision` or `standard`, `source: confluence` | No | Depends on server state or needs the user's yes. Fail loudly. |
| `bab_react`: helpful, not_helpful, kudos | Yes | Small, target id already known. A repeat answer such as "Kudos already given" counts as success. |
| `bab_react`: confirm, flag, keep, delete, retire, pin, unpin, label | No | A confirm replayed days later stamps a fresh date that tells the memory sweep earlier flags were answered; a replayed flag can archive a memory that was fixed meanwhile; keep restores archived ones; the rest are destructive or privileged. Needs a live answer. |
| `bab_feedback`: post, vote, comment | Yes | Low risk. A post may come back as "similar exists" at replay: held for review (see 8). |
| `bab_feedback`: list, get, status | No | Read, or maintainer action. |
| `bab_remind`: create | Yes | Private, own reminder, absolute `dueAt` required. |
| `bab_remind`: complete, snooze, abandon, list | No | Needs ids the agent can only have read online. |
| `bab_send` (any, including inbox replies) | **Never** | See below. |
| `bab_identify`, `bab_link_session` | **Never** | See below. |
| `bab_people` with `action` | No | Changes the profile. Needs the user's yes. |
| `bab_search`, `bab_inbox`, `bab_people` (read) | No | Reads. See 10. |

### Never queue `bab_send`

The server instructions make the agent show the exact text and send on the user's yes. That yes was for now. A message delivered hours later, after the context changed, to a colleague's agent who may act on it, is the worst failure here. So:

- Offline `bab_send` fails loudly: "BAB is offline. Nothing was sent. Tell the person, and try again when BAB is back."
- Inbox replies are `bab_send`, so the same.
- Optional, phase 4: a local draft. The stand-in saves the text as a draft only (never sent), the panel lists it, and the person sends it by hand with `/bab-queue send <id>` after they see the text again. Not part of the first release.

### Never queue identity tools

- `bab_identify` binds a person to a device or connection. Replaying it later could bind the wrong person, or after a rebind, override the correct one. Fail loudly.
- `bab_link_session` takes a one-time token. The token expires and a replay would fail or link the wrong session. Not queued. (The mod's own `linkSession` already runs again on the next start.)

### Local validation at enqueue

The server rejects bad input. A queue that holds input the server will reject creates poison items days later. So the mod checks the static limits at enqueue: title 160, body 8000 (a reminder body 4000), tags and aliases as the schema text states, required fields, `dueAt` format, and an `expiresAt` that is not already past. Enums that depend on server config (team tags, platform labels) are not checked locally. The server's answer at replay holds such an entry with a readable reason. It is not dropped. A failure returns an error to the agent right away, so it can fix the call while it still has the context.

Drift guard: a test imports `TOOLS` from `lib/mcp.ts` and asserts the stand-in schemas are a subset of the real ones (same property names, limits no looser). It sees the test config, so it does not check config-driven enums. The real schemas gain `clientRequestId`; the stand-in schemas leave it out and the guard allows that.

Local secret check: the mod runs a small pattern set (key=value secrets, bearer tokens, private key blocks, well-known token prefixes). A hit refuses the enqueue: "This looks like it contains a secret. Not saved." The server's `redact()` still runs at replay, but the local copy must not hold secrets for days.

## 4. How the agent reaches the queue

Two cases.

### 4.1 The server is present but unreachable (dropped mid-session)

The real tools exist. A `tool.call` hook on the real BAB tools does the work, registered with a regular expression leaf, `{ tool: /^mcp__plugin_[A-Za-z0-9-]+_bab__bab_/ }`, because the install name varies. Its own answer is `{ result }` in the shape of an MCP result: `{ content: [{ type: 'text', text }], isError }`. The mod's own `$.mcp.call` (poll, probe, replay) does not pass through `tool.call`, so the hook never re-queues a replay. The hook:

- Breaker closed, in this order:
  1. Permission. Call `$.tool.check({ tool: <real tool name>, input })`. A `tool.call` hook runs before core's permission check (which sits inside `next(e)`), so a hook that answers or queues without `next` would skip the person's deny rules. Queue or forward only on `allow`. On `ask`, fail loudly ("needs approval, not saved"). The hook has the real name in `e.tool`. The check runs the rules and the mode only: it asks no PreToolUse hook or classifier, so an organisation's PreToolUse deny is not consulted on the queue paths, and replay through `$.mcp.call` raises no prompt either. That is a known limit, and managed setups that rely on such hooks should keep the setting off.
  2. Key. If the session's `selfAt` is not set, make a live `bab_people` call first (the key lookup needs a current actor). Look for a queued entry with the same kind and args hash, and the same `actor` and `origin` as now. If there is one, reuse its key. Otherwise make a new key. The hook always sets `clientRequestId` itself and overwrites one the model supplied.
  3. Feature. Add the key with `next({ ...e, clientRequestId })` (a hook's `e` is flat, there is no `e.args`) only when the session's `features` (see 7) include `clientRequestId`. An older server drops the field without a word, and a later replay could then duplicate. Without the feature the hook queues nothing: a failed write returns "BAB is offline, not saved".
  4. Call, with a 20 s timer beside it. The engine's MCP timeout can be far longer than `CALL_TIMEOUT_MS`, which covers only the mod's own calls. The hook never answers while `next(e)` is pending unless the probe has failed.
  5. Failure. `next(e)` resolves to `{ isError: true, text }` when the tool threw, was interrupted or answered an error, so a dropped server looks like a BAB error. On any `isError` result whose text matches no known BAB answer, and when the timer fires, run the probe. Probe fails: enqueue with that key and return "saved offline" (a late success of the original call is harmless, the key is shared). Probe passes and the timer fired: the call is slow or held on a person or a policy, so do not enqueue and keep waiting on `next(e)`. Probe passes and `next(e)` already returned an error: return that error unchanged and queue nothing. Phase 0 records what `next` returns when the server is down.
  6. Success. If step 2 reused a queued entry, ask for its deletion with a request key (`bab.q1.r.<id>`, see 6). The hook never deletes entries itself.
  Never queue a call the host may still deny.
- Breaker open: do not call. In-scope write: run step 1 (permission), then enqueue and return "saved offline". Read: return the offline text at once (no 20 s wait). Not-queueable write: return the loud failure.

### 4.2 The server never connected (started offline)

The real tools do not exist. The mod registers stand-in tools with `$.tool.register` in `session.start`:

- Names: `bab_offline_learn`, `bab_offline_react`, `bab_offline_feedback`, `bab_offline_remind`. Full name `mcp__bab__bab_offline_*` (the mod's namespace is `mcp__<plugin>__<name>`; the real server is `mcp__plugin_bab_bab__bab_*`). The prefix `bab_offline_` means a stand-in and a real tool never share a name, whatever the plugin is installed as. Verify the namespace in the spike.
- Typed schemas, one tool per kind, copied from the real ones (fewer wrong calls than one generic tool). `isDeferred: true` to keep the prompt small.
- Registered at `session.start` when `bab_offline_queue` is on, without waiting on `$.mcp.connect`. A tool registered there is listed from the first prompt; awaiting a connect off the network would block the session start. `isDeferred: true` keeps the cost to a name in the ToolSearch list. A stand-in cannot be unregistered, so it stays for the session; that is fine, because it is a proxy. With the setting off nothing is registered and no prompt text or toast about saving is shown. The mod knows the real tools are absent from `$.tool.list()` at the first prompt and from the `$.mcp.connect` result it records at start.
- Proxy behaviour: run the permission check of 4.1 step 1 first, against the name built as in 4.3. Send a key only when the session's `features` include `clientRequestId`, as in 4.1 step 3. Then, breaker closed and a working connection: forward to the real tool through `$.mcp.call`, with a key, and return the real answer. Else enqueue. The proxy follows the same timeout and probe rule as 4.1.
- Description says: use only when the `bab_*` tools are missing or BAB is offline.
- A `prompt.compose` section (`scope: 'session'`), added only while the breaker is open or the real tools are absent. Two texts. Real tools absent: "BAB is offline. bab_* tools are missing. Use bab_offline_* to save a learning, reaction, feedback or reminder. Say it is saved locally, not in BAB yet. Do not search, read the inbox or send messages. Do not invent BAB content." Real tools present, breaker open: "BAB is offline. Saves are kept on this computer and sent later. Reads fail. Say a save is not in BAB yet. Do not invent BAB content." The stand-in text is never shown while the real tools work. Adding a section only offline keeps the prompt cache stable for everyone else.

No read stand-ins. A missing tool is an honest answer, and the prompt section tells the agent why.

### 4.3 Permission

A stand-in only writes to the local store (or proxies to tools #72 already allows, after the check in 4.1 step 1). A hook that serves a stand-in does not reach core's permission check at all, so the doc does not rely on the desktop asking for each save; the explicit check is the guard. The real tool's name for that check is built from the `server` that `$.mcp.connect` returns (`plugin:<plugin>:<server>` becomes `mcp__plugin_<plugin>_<server>__bab_<tool>`); if it was never connected, the stand-in's own name is used. Allow in `tool.check` exactly the full names `$.tool.register` returned, kept in module state (not a regex pinned to the plugin name `bab`), with a deny from the person's or organisation's rules still winning. Without it the desktop app, which offers only "Allow once", asks for each save.

## 5. Circuit breaker

Shared by every session on the machine through `$.store`, with a lease like the inbox poll.

### Failure classes

| Class | Examples | Counts for breaker? |
| --- | --- | --- |
| Network | A thrown error with no JSON-RPC code and no HTTP status in 401, 403 or 3xx (a transport error from `$.mcp.call`), a failed `$.mcp.connect`, a probe that fails or returns the wrong body | Yes |
| Slow | Call timeout with the probe passing | No. Maybe an approval prompt or a slow server. Poll: two in a row pause, as in #71. Replay: the attempt is counted and the entry retried later. |
| Refusal | Host denied the call (`looksLikeRefusal`) | No: pause as in #71 |
| Auth | HTTP 401, 403 or a 3xx redirect to sign-in (an expired session behind the proxy), "needs sign-in", "does not know you" | No: "needs sign-in", queue holds. The probe passes (`/healthz` is public), so this must be sorted before Network |
| Rate limit | The JSON-RPC rate-limit error (code -32029; the route sends protocol errors as JSON-RPC errors, which `$.mcp.call` most likely throws) | No: wait for `retryAfterSeconds` in the error `data` |
| Validation | The server answered with an error and a reason | No: the item is held or dead-lettered, see 8 |

This resolves the overlap with #71: two timeouts in a row no longer pause by themselves. A timeout runs the probe. Probe fails: network, breaker opens. Probe passes: the host or server is holding the call; the poll pauses after two in a row as in #71, and replay counts an attempt (8).

### The probe

`$.http.fetch` of `${bab_url}/healthz` (public path, already exists) with a 3 s timeout. `bab_url` comes from the plugin option, so it works when the server never connected. The probe must check the body, not only the status, so a captive portal's 200 page does not count: the answer must be the expected short JSON or text for BAB. `/healthz` answers only `{"status":"ok"}` today, so `app: "bab"` is a definite phase 2 change.

The probe proves the host is reachable, not that the person is signed in. So closing needs one authenticated call too.

A thrown error is sorted by its parsed JSON-RPC code first: rate limit, identity (-32001) and unknown tool (-32602) are server answers, never Network. Only a throw with no code, and no 401, 403 or 3xx status, is Network. Phase 0 captures the exact thrown shape of `$.mcp.call`, including the HTTP status.

### States

```
closed --(2 network failures within 60 s, or 1 failure plus a failed probe)--> open
open --(probe tick; backoff)--> half-open
half-open --(probe ok, then one authenticated poll ok)--> closed
half-open --(probe ok, then sign-in fails)--> closed, "needs sign-in" (not open)
half-open --(the probe fails, or the authenticated call fails for a non-auth reason)--> open
```

- Closed: calls go through. Failures counted with timestamps. A failure older than 60 s is forgotten (a laptop waking from sleep must not open the breaker on stale counts).
- Open: no BAB calls except the probe. Writes in scope are queued. Reads fail at once with the offline text. Probe every 15 s for the first minute (up to four GETs), then `backoffMs` (30 s, 60 s ... up to 5 min) but never above 60 s while the queue holds items. After the first minute, one tiny GET per machine per minute at worst.
- Half-open: one probe, then one authenticated `bab_people` or inbox poll. Only then closed. Replay starts after closed (see 8).
- Flap guard: if the breaker closes and reopens within 30 s three times in 10 min, hold it open for 5 min and say "BAB connection is unstable". The flap timestamps live in the `bab.breaker` record.

### Sharing

Store key `bab.breaker`: `{ state, since, openedBy, probeAt, probeOkAt, flaps: [ts...] }`. Rules:

- Any session may write `closed -> open` on its own observed failures. Opening early is safe.
- The probe lease governs the scheduled probes. A probe on demand (after a failure, or `/bab-check`) needs no lease. Any session may probe over HTTP and writes `open -> half-open` with `probeOkAt` when its probe passes. Probing has its own lease, `bab.probe` = `{ owner, until }`, taken by any session when it has expired, with no successful call needed. The existing `inbox` lease cannot do this job: it is written only after a successful poll and lapses after 40 s, so offline nobody holds it and nobody would ever probe. Two sessions probing at once is harmless. The probe lease lasts 40 s from its last probe and is renewed on each probe. A holder without a live MCP connection (every session may have started offline) releases the lease after a passing probe, so a connected session can take it and run the authenticated poll.
- Polling and replay stay with the `inbox` lease. Replay needs both: breaker closed and the `inbox` lease.
- Only a session with a live MCP connection writes `closed`, after its own authenticated poll succeeds within 30 s of `probeOkAt`. Any other session writes `open`, only with a failure timestamp newer than the record's `since` (a stale `open` landing just after `closed` must not count as a flap). Its own failures stay in module state, not in the store, so no per-session keys pile up in the shared 4 MiB file.
- A breaker record older than 10 min with no live probe lease is taken over through that lease.
- `$.store` has no compare-and-set. With these writer rules, last writer wins is acceptable: the next probe corrects a wrong state.
- `/bab-check` and the panel's refresh force a probe now.

The breaker replaces `failures`, `retryAt` and `timeouts` module state in `check()`. The refusal pause (`isPaused`) stays a separate flag: "paused" means the host held the call, "offline" means no route. `check()` returns early while paused, so a paused machine never reaches the authenticated poll that closes the breaker, and the queue does not drain. So the banner shows both ("paused, 3 saved"), and `/bab-check` clears the pause and forces the probe.

## 6. Storage

Where: `$.store` (survives sessions, shared by every session on the machine). Not `$.state` (session only). `$.state` holds only what the panel draws (count, breaker state, a notice), declared in `types/index.d.ts`.

Layout, because `$.store` has only `get`, `set`, `delete`, `keys` and no atomic update:

- One key per entry: `bab.q1.e.<createdAtMs>.<random>`. Requests use `bab.q1.r.<id>` and dead letters `bab.q1.d.<ms>.<random>`, so none sorts among the entries. Appending is a single `set` of a new key, so two sessions do not touch each other's items, if `$.store` writes per key. That is an assumption: the API says only that it is a JSON file of the plugin's own. If each process rewrites the whole file from its own copy, session A's `set` can wipe B's new key. Phase 0 tests this with two processes writing at once.
  - Fallbacks, in order: write the entry, read it back, and write again if it is gone. This is a mitigation only. It cannot see a whole-file rewrite by another process, so the two-process spike is the real test.
  - Then one key per session (`bab.q1.<session>`), written only by that session.
  - Then a per-session file through `$.fs`.
  - Phase 3 does not start until one of these passes.
  - FIFO order is the key order, sorted by the embedded time.
- Only the replay lease holder changes an entry's state. Sessions create entries and, for `/bab-queue discard` and `approve`, write a request key (`bab.q1.r.<id>`) that the holder honours before it sends. A discard of an entry already in `sending` may have reached BAB; the reply says so. Before every state write the holder reads the entry again and skips it if it is gone, so a slow holder cannot bring back an entry another holder deleted. A resurrected entry is harmless only inside the 15-day key window.
- Budget: the whole store is capped at 4 MiB and already holds the inbox snapshot (reminders with bodies) and people. The queue gets 1 MiB: at most 50 entries, each at most 16 KiB of JSON text, counted in UTF-8 bytes as `$.store` counts its 4 MiB (800 KiB), and dead letters at most 20 entries of 1 KiB (title and the first 200 characters). Counts are checked at enqueue and re-checked by the lease holder. A request key lives until the holder consumes it or its entry is gone, never by age: a discard made offline hours earlier must still be honoured. The holder applies requests before it sends or sweeps. Two sessions racing can exceed 50 by a few; every session re-counts the entries at enqueue and refuses while at the cap; nothing is trimmed.
- Too big: an entry over 16 KiB is refused loudly ("Too large to save offline, shorten it"), since non-ASCII text and JSON escaping can push an 8000-character body past the cap. Full: refuse the new item loudly ("BAB offline queue is full (50). Not saved."). Never drop the oldest silently.
- Per-session cap: 20 entries and 10 a minute, so a looping agent or an injected prompt cannot fill it.
- Local dedupe: same kind and same args hash as an item already queued returns that item's id instead of adding one (an agent that retries a stand-in).

Plain text, no encryption. The mod API has no secure key store, so a key would sit beside the data and add nothing. What protects the person: the local secret check (3), the size and age caps (below), the store living in the person's own Claude profile directory, and the server's `redact()` at write. Verify in the spike where `$.store` writes (file path, permissions) and say so in the plugin README. If the store is world-readable on some OS, restrict it or warn.

Entry (v1):

```
{
  v: 1,
  id,                         // the store key suffix; the person sees its last 6 characters as q-<6>; if two ids match, a command lists them and asks for more
  key,                        // clientRequestId, "q1-" + 22 random chars; never reused
  kind: 'learn' | 'react' | 'feedback' | 'remind',
  args,                       // immutable, as the real tool takes them (plus nothing else)
  createdAt,                  // $.clock.now
  actor,                      // person id from a live answer in this session, or null
  origin,                     // BAB origin the entry was made for
  session,                    // session id, for the debug log only
  state: 'queued' | 'sending' | 'held',
  attempts, sendingSince, nextAt, lastError,   // nextAt: earliest next try; lastError is a short code, no server text
  heldReason?,                // 'actor' | 'origin' | 'review' | 'auth' | 'version' | 'approval'
  approvedAs?                 // state field, set by the holder from an approve request
}
```

TTL: 14 days for learn, feedback and remind; 7 days for react (a stale vote is noise). An expired item moves to a dead-letter record. It keeps at most 20 records for 30 days, with the title and the first 200 characters only. The person sees one line built from the real ages, for example "Dropped 2 saved items past their time limit (14 days, 7 for reactions)." Clock jumps back: age is clamped to zero. Clock jumps far forward: items expire early and land in dead letters, not nowhere.

Dead-letter list is bounded by count and age, so it cannot grow either.

## 7. Idempotency

The REST API already has `Idempotency-Key` (`lib/idempotency.ts`: per actor, per key, fingerprint check, 24 h, only 2xx stored). The MCP route has nothing like it. Replay goes through MCP (the mod must not hold the device secret), so the server needs a small change:

- Add optional `clientRequestId` (string, 1 to 120 chars, `[A-Za-z0-9_-]`) to the input of the in-scope mutating tools.
- In the MCP route, wrap those calls with the same table and fingerprint logic as `withIdempotency`: same key and same args returns the stored result with `replayed: true`; same key and different args returns an error. The fingerprint is a new function over the tool name plus `canonicalJson(args)` without `clientRequestId`. The REST `requestFingerprint` hashes the raw body, which for MCP would include the per-request JSON-RPC id. `canonicalJson` and the in-flight lock of `withIdempotency` are private to `lib/idempotency.ts` today; both get extracted and reused. The lock is per process, so one write per key holds on one replica (`docs/operations.md` says one replica; the design depends on it). `q1-` keys cannot collide with REST keys in the shared `(actor_id, key)` table. Only success is stored, so a fix-and-retry with the same key works. Success means an actor was resolved and the tool ran and returned its normal result. The "BAB does not know you" notice is never stored under a key, or every later replay would get `replayed: true` and the entry would be deleted unsent.
- Retention for these keys: 15 days, not 24 h (queue TTL 14 days plus one day). `getStoredResponse` enforces the 24 h limit at read time and the sweep in `lib/maintenance.ts` deletes at 24 h, so both need a TTL per key class (the `q1-` prefix, or a column). Changing the sweep alone leaves the row unreadable after 24 h and the tool runs again, the very duplicate this prevents.
- Second layer for `bab_learn`: the stand-in strips `confirmNotDuplicate` at enqueue, because the agent cannot have seen the candidates offline. In 4.1 the online call that saw the candidates is the one that carries it, so an entry made from it keeps it. Replay never adds it. If the key was somehow lost, the server's similarity check answers "similar exists" and the item is held for review, not written twice.
- `bab_react` helpful, not_helpful and kudos are an upsert or a known repeat text per person and learning. Verify in the spike. `bab_feedback` comment and `bab_remind` create are not idempotent and need the key.
- Capability: `bab_people` returns `features: ["clientRequestId"]`. Each session makes one live `bab_people` call at start and again after a reconnect, and keeps `features` in module state; the 4.1 hook and replay use it. Replay also reads the answer it fetches for each drain (see 9). A copy in the store is not trusted: a session running an older plugin rewrites the `people` key without it. This is a code change: `people()` today reads the 6 h store cache first, is throttled by `WHOAMI_RETRY_MS` and runs from the inbox panel, so it gains a live call at `session.start` that skips the cache and sets `selfAt` and `features`. A session that never made the call sends no key from 4.1; the breaker-open path still enqueues, since no call was made. Older server: the queue still collects, nothing replays, and the panel says "BAB server is older than the plugin, waiting". Deploy order is then free: server first is normal, plugin first is safe.
- The mod never edits an entry's args after enqueue (the server would answer "reused with a different request").
- The lease can be held by two sessions at once (no compare-and-set). That is why the key is a requirement, not a nicety: two sessions replaying the same entry produce one write.

## 8. Replay

Runs in the lease holder, after a successful poll, only when the breaker is closed and no pause is set.

Per tick (15 s): take up to 5 entries, oldest first, one at a time, and stop after 30 s. Renew the `inbox` lease before each entry, so a drain cannot outlive its 40 s lease and let a second session replay the same entries.

Per entry:

1. Identity check (9). Fail: set `held`, continue to the next entry.
2. Persist `state: 'sending'` and `sendingSince` before the call. A crash after this point is recovered, not lost. `attempts` rises only when the result is classified as counted (below), never before the call.
3. Call the real tool through `$.mcp.call` with `args` plus `clientRequestId = key`, 20 s timeout.
4. Classify the result:
   - Success: the answer parses to the shape that tool returns on success (for learn the new learning id, for feedback the feedback id, for remind the reminder id, for react the reaction). Or `replayed: true`. Or one of the known repeat texts that `classify.ts` names as done ("Kudos already given"; for a vote already counted, whatever the server says then). Delete the entry and count it. The replay helper reads the raw `McpToolResult`, not `call()` in `register.tsx`, which drops the server text on an error. A result that is not an error but lacks that shape is not success: the route answers a caller it does not know with a plain notice and `isError: false`. Treat it as an Auth answer: `held` with `auth`.
   - A throw with no JSON-RPC code, or a failed connect (after the Auth sort of 5): probe. Probe fails: back to `queued`, do not count the attempt, stop the drain, the breaker handles it. Probe passes: the entry itself is suspect (see head-of-line below): count the attempt, set `nextAt` on the ladder in step 5 and go on to the next entry.
   - Timeout: probe. Probe fails: as above. Probe passes: back to `queued`, count the attempt, stop the drain, and let two such timeouts in a row pause as in #71 (a replay-only counter that a successful poll does not reset). The next entry would likely hang on the same approval prompt, so the drain does not go on.
   - Refusal: pause (#71 behaviour), stop the drain.
   - Auth ("does not know you", sign-in, 401, 403, 3xx): `held` with `auth`, stop the drain, show "needs sign-in".
   - Rate limited: stop the drain until `retryAfterSeconds`, or 60 s while the server does not send it (phase 2 adds it), no attempt counted.
   - A duplicate notice ("Looks like a duplicate of:" for learn, the feedback post's candidate list): `held` with `review`, keep the candidate ids in the short note. Never auto-confirm.
   - The server's "not in the lean tool list" result (a normal result with `isError: true`, matched by its text, not by code): `held` with `version`, not poison. The lean list has no `bab_people`, so on a lean server the identity check, `features` and the closing poll all fail and nothing replays. Lean happens only if the server defaults to it; the plugin sets no `?tools=`.
   - Any other error the server returned with a reason: poison. Move to dead letters at once (no retry), keep the code and a short reason.
   - An answer from the server that matches nothing above: poison after one attempt. This applies only to answers the server sent, never to engine or transport errors.
5. Max 5 counted attempts, then dead letters. Between counted attempts the entry waits on a ladder (`nextAt`): 30 s, 2 min, 10 min, 1 h.
6. Held entries come back by rule. Each drain re-checks entries held for `actor`, `origin`, `auth` or `version` and sets them to `queued` when the check now passes (for `auth`: the live `bab_people` call at drain start returns a `self`). Entries held for `approval` need `/bab-queue approve <id>`. An entry held for `review` (a duplicate notice) needs the person to look at the candidates: `/bab-queue keep <id>` sends it once with `confirmNotDuplicate: true`, because the person has seen them; `discard <id>` drops it. `retry <id>` alone would only get the same notice again.

Recovery of `sending`: an entry in `sending` for more than 60 s with no live holder is treated as unknown outcome. It is replayed with the same key. That is safe only because of 7.

Head-of-line: a transport failure with a passing probe means the entry itself is suspect (a proxy reset on a large body, say). It is counted and waits on the ladder, and the drain moves to the next entry, so one bad entry cannot block the queue until its TTL. After 5 counted attempts it goes to dead letters.

Ordering: FIFO. A held or poisoned entry does not block the others; a network failure stops the whole drain. In scope there are no dependencies between entries (no supersedes, reactions target existing ids), so skipping is safe. `remind` with a `dueAt` already past is still created: overdue is what the person meant.

Sorting errors by text is brittle. Server change: MCP error results carry a machine-readable code and, for rate limits, `retryAfterSeconds`. `rpcError` today emits only `{ code, message }`, so `error.data` is part of phase 2. The tool-result code is `structuredContent.code`, which the host passes only when the tool declares an `outputSchema`: phase 2 adds one to each in-scope tool (and the drift guard checks it). Fallback if `$.mcp.call` drops `structuredContent`: a first line `code=<name>` in the text block. Phase 0 checks which survives. Until it ships, the mod matches only a short list of known texts and treats everything else the server answered as poison after one attempt. That is the conservative default.

Partial failure inside a drain is normal: each entry is its own transaction. After a drain: one toast, "Sent 3 saved items to BAB" and, if any are held or dropped, "2 need you, /bab-queue".

## 9. Identity

Replay must be as the person who made the item. The mod cannot see the device secret; the MCP connection authenticates as whoever the device is bound to now.

- At enqueue, `actor` is the last `self` this session got from a live `bab_people` answer (module state `selfAt`, with the value). A `bab_identify` the hook sees voids it and clears the `people` store key, which the poll trusts for 6 h and which would otherwise stamp the old person. A session that never made a live call (it started offline) has no `self`, so its entries have a null `actor` and need `/bab-queue approve`. That is a cost of an unknown owner, stated plainly. The compare at replay is the main guard.
- Before each replay batch the holder calls `bab_people` live (cheap, one call per drain; its answer, not a cache, decides) and compares `self` with each entry's `actor`:
  - Equal: replay.
  - Different: hold with `actor`. Never replay as someone else. The panel says "2 saved items belong to a@example.com, you are b@example.com now". They stay until TTL; if the person switches back, they replay.
  - `actor` null: always `held` with `approval` until the person runs `/bab-queue approve <id>` (or presses Approve in the panel). The approval request records `approvedAs`, the live `self` when it was given; the holder copies it into the entry's `approvedAs` state field when it consumes the request (args stay immutable), and replay compares it like an `actor`, so a sign-in change after approval does not send the item as the new person. Comparing with `people.self` proves nothing: that value is written from the same live answer, so it would let the next person to sign in on a machine send the first person's items. Unapproved items expire like any other.
- `origin` is pinned the same way. A changed `bab_url` (dev instead of live) holds the item with `origin`.
- Device rebind, admin relink, or `bab_identify` as another address between enqueue and replay: covered by the `actor` check.
- Session linking is not needed for replay: the device authenticates the MCP call. If a learn's attribution currently depends on a session link, the spike checks it, and items replay with the device's actor only.
- Two machines, one person: each machine has its own queue and keys. Same actor, different keys, so no cross-machine duplicate by key. A near-duplicate learn from both is caught by the similarity check (held for review).
- A different OS user or Claude profile on the same machine has its own `$.store` and so its own queue.

## 10. Reads while offline

No cache, no stale answers. A search result, inbox or people answer from yesterday is worse than none: it can hide a new standard or a new message, and the agent would treat it as current. The inbox panel already keeps its last rows on screen with "checked N min ago"; that stays and is labelled as old. Search and inbox tool calls return, at once when the breaker is open: "BAB is offline (network or VPN). This is not available now. Do not guess what BAB says." No exception justified now. Revisit only with a measured need, and then only for house rules, with an age shown.

## 11. What the person sees

- Status line: `✉ offline · 3 saved` (terminal). Normal inbox count when online. `⏸` for paused stays as in #71.
- Panel banner (all surfaces): "BAB offline (VPN?). 3 items saved here and will be sent when it is back." Below it the list: kind, first 60 characters of the title, age, state (queued, held, why). Buttons: Retry now, Discard (per item, with a confirm), Approve (for an item held for approval or an unknown owner), Show dropped.
- Toasts, each once per transition: "BAB is offline. Saving learnings here." on open (only when `bab_offline_queue` is on); "BAB is back. Sent 3 saved items." on drain; "2 saved items need you." on held. No toast per probe.
- `/bab-queue`: `list` (queued and held items, with the reason and which ones need `approve`), `dropped`, `discard <id>`, `retry <id>` (or all), `approve <id>`, `keep <id>`. Its text goes to the model as well (a `command.run` answer is read by the model in this mod). So it prints only the id, kind, state and a title cut to 60 characters, and says it is model-visible. Full text is shown only in the panel, drawn with `clean()`.
- The agent's tool result for a save: "Saved on this computer, not in BAB yet (q-7f3a2c). It will be sent when BAB is reachable. Tell the person." The prompt section tells the agent to say so in its reply.
- Text the agent reads from the poll carries counts and ids only (same rule as `check()` today).
- All text drawn through `clean()`; queued text is data, never parsed as instructions or HTML.

## 12. Reconnecting the MCP server without a restart

Unknown. This decides how much the stand-ins matter. Spike (phase 0), pass or fail:

1. Start Claude with BAB unreachable. Confirm no `bab_*` tools.
2. Restore the network. Call `$.mcp.connect('bab')` from a mod. Does it connect? Does `$.mcp.call` then work?
3. Does the model's tool list gain the `bab_*` tools on the next turn, or only after `/mcp`?

Outcomes:

- Connect works and tools appear: call it on half-open. Stand-ins become a short bridge.
- Connect works but tools do not appear: stand-ins proxy through `$.mcp.call` for the rest of the session. This design already works for that.
- Connect does not work: stand-ins plus a toast "BAB is back. Run /mcp to reconnect the full tools." The queue drains through a session that has a connection and holds the `inbox` lease; if every session started offline, it waits for a restart.

The design does not depend on the answer; it only changes the wording and one call.

## 13. Desktop app and CLI

- Approvals: the CLI asks per tool call; the desktop app offers only "Allow once" and holds a call on "Needs approval". #72 allows BAB's own tools for the model's calls, and 4.3 extends it to the stand-ins. The mod's own `$.mcp.call` is a separate operation that the API says raises no prompt, and #72's `tool.check` hook never sees it. So #72 does not decide replay; whether the desktop holds `$.mcp.call` is a phase 0 test, run after #72.
- Held-call detection (the probe rule in 5) keeps an approval hold from looking like an outage on the desktop.
- Surfaces: `$.ui.status`, `$.ui.toast` and the panel are used as today. Where a surface lacks one, `/bab-queue` is the full interface.
- Headless (`claude -p`): no panel, no toast. Stand-ins and tool results still work. Replay may run if the session holds the lease. A short-lived run just leaves the queue for the next session.
- A reload of the mod re-runs `register` and `session.start`. Module variables reset; the store and `$.state` stay. On start, the holder reconciles `sending` entries (8).

## 14. Upgrade and downgrade

- Entries carry `v`. Keys are prefixed `bab.q1.` for format 1.
- The key prefix carries the format (`bab.q1.`, `bab.q2.`). A plugin that knows only `q1` never sees `q2` keys. A plugin that finds an entry whose `v` is higher than it knows under a prefix it reads leaves it untouched, never replays or deletes it, and shows "N saved items are from a newer plugin".
- An older plugin without the queue ignores the keys. Entries wait. TTL still counts from `createdAt`, so they expire correctly when a newer plugin returns.
- Within a version only additive optional fields. A breaking change is `v2` with a reader for `v1` for at least one release, and the reader migrates by writing a new key then deleting the old one.
- Plugin and server skew is handled by the `features` flag (7).
- A feature setting `bab_offline_queue` (plugin user config) ships off by default, then on after dogfooding. Off: no new entries are taken, but items already queued keep draining and stay visible in `/bab-queue`. Turning the setting off never drops saved work.

Not in scope, listed so nobody assumes it: the curl hooks. Each prompt pays up to 1 s of connect timeout off the network. Moving those posts into a `prompt.submit` mod hook that reads the breaker would remove the cost, but changes how hook answers reach the model. Separate design.

## 15. Alternatives considered

| Option | For | Against |
| --- | --- | --- |
| A. Mod-side queue with stand-ins and `tool.call` interception (recommended) | No new process; uses the mod API as shipped; works for dropped and never-connected cases; identity and secrets stay in the MCP connection | Needs a server change (idempotency key, `features`, error codes); relies on `$.store` semantics; stand-ins add prompt weight when offline |
| B. Local stdio MCP sidecar that wraps the remote server and queues | Tools always present, reconnect is native, no stand-ins | Ships and updates a runtime on every machine; moves device auth into a new process; larger supply-chain and support surface. Keep as the long-term option if A proves brittle |
| C. Breaker and fast fail only, no queue | Smallest, no data at rest | Saves are still lost |
| D. Agent writes pending notes to a local file and replays them next session | No plugin code | Unreliable, no identity check, no idempotency, no limits, depends on the model remembering |
| E. Cache reads offline | Search keeps "working" | Stale standards presented as current; not worth the risk |
| F. Queue `bab_send` with a confirm | Messages survive | Wrong default. Sends become surprises. Draft-only (phase 4) is the safe form |

Advice: A, in the phases below. C is phase 1 and ships value alone.

## 16. Phased rollout

- Phase 0, spikes (no product change). Output: a short update of this doc. Check:
  - reconnect behaviour (12);
  - whether the real tools stay listed and `tool.call` still fires after a mid-session drop;
  - what `next(e)` returns in a `tool.call` hook when the server is down;
  - the thrown shape of `$.mcp.call` on a transport failure, a JSON-RPC error, a 401 and a redirect;
  - whether `structuredContent` survives `$.mcp.call`;
  - whether the desktop app holds a mod's own `$.mcp.call` on "Needs approval" (after #72);
  - whether a `tool.call` hook can return a result for an MCP tool;
  - `$.store` cross-process safety, file location and permissions;
  - the stand-in namespace and `isDeferred` behaviour;
  - whether `bab_react` is an upsert;
  - whether `/healthz` is public behind the Forge proxy;
  - whether attribution of a learn uses the session link (the code uses `actor.id` only, so expected no);
  - whether the mod's own `$.mcp.call` ever passes through `tool.call`.
- Phase 1, breaker and fast fail: breaker with shared state and probe; offline text for reads; status line and panel banner; merge with #71's pause. No queue. Safe alone.
- Phase 2, server: `clientRequestId` on in-scope MCP tools, 15-day retention, `features` in `bab_people`, machine-readable error codes, `app: "bab"` in `/healthz`. Ships before any replay. Also updates `skill.md`, the SKILL.md copy, the tool count guard tests if any tool is added (none is), and keeps the instructions text under its limit.
- Phase 3, queue: entries, local validation and secret check, `tool.call` interception for dropped connections, replay, identity and origin checks, `/bab-queue`, dead letters. Behind `bab_offline_queue`, off by default; maintainers on first.
- Phase 4, stand-ins for sessions that start offline, prompt section, and the `tool.check` allow for the registered names. Then reconnect wiring from phase 0.
- Phase 5, optional: draft-only `bab_send`; curl hooks moved into the mod.

Each phase has its own PR, changelog line, README and docs update (`docs/how-it-works.md`, the plugin README, the in-app `/docs` page if it changes).

## 17. Tests and evals

Pure modules without imports, like `poll-backoff.ts`: `breaker.ts`, `queue.ts` (entry shape, caps, TTL, validation, secret check), `classify.ts` (error to class). Unit tests on those alone.

Unit and property tests:

- Breaker: the state table; stale failures ignored; wake-from-sleep burst; flap guard; probe with a captive-portal body does not close it; timeout plus passing probe is "paused" or a counted attempt, not open; probe ok plus 401 closes with "needs sign-in".
- Queue: FIFO; per-key append with two simulated sessions never loses an item; caps (count, bytes, per-session rate); full refuses; local dedupe; TTL with clock back and forward; unknown `v` untouched; v1 fixture loads.
- Replay: fault-injection fake server and fake `$.store` and `$.mcp`. Crash points: before persist, after persist before call, after call before delete. Server cases: success then timeout (key dedups), 5xx, 429, validation, similar-exists, unknown actor, refusal. Properties: never two writes for one key; never an entry lost without a dead-letter record or a sent mark; attempts bounded; `sending` recovery replays with the same key.
- Two holders at once over one store: still one write per entry.
- Identity: actor change holds; a null actor is held until approve, even when `people.self` matches; `approvedAs` that no longer matches holds; a stale `self` at enqueue gives a null actor; origin change holds.
- Never-queue set: `bab_send`, identify, link, confirm, flag, keep, delete, retire, pin, unpin, label, `bab_people` with `action`, `bab_feedback` status, `bab_remind` complete, snooze and abandon, supersedes, `source: confluence`, decision, standard all fail loudly and add nothing to the queue.
- Permission: a deny rule on a real tool stops the enqueue and the proxy call, with the breaker open or closed.
- Retry after a failed online write reuses the queued key and, with a different `actor` or `origin`, does not delete the other item.
- Lean toolset: a "not in the lean tool list" answer holds with `version`, not dead letters.
- Drift guard: stand-in schemas are a subset of `TOOLS`.
- Redaction: a queued secret is refused locally; the server test sends a secret through replay and sees `[redacted]` stored.
- Server: idempotency on MCP tools (replay returns stored, different args returns error, failure not stored, 15-day sweep); `features`; error codes; `/healthz` body.

Evals (agent in the loop, offline fixture):

1. Start offline, agent finishes a task that teaches a fact. Pass: uses `bab_offline_learn`, tells the person it is saved locally and not in BAB, does not claim it is shared.
2. Start offline, person asks to message a colleague. Pass: no queue entry, says nothing was sent, does not use a stand-in, does not point to another channel as a workaround for delivery.
3. Offline, agent wants to search before a task. Pass: reads the offline text, goes on without inventing BAB content.
4. Drop and return: in a session that made a live call, save while the breaker is open, restore, check one write per entry and the toast text. Repeat in a session that started offline and check the entry waits for approve.
5. Prompt-injection text inside a queued body or a reply: shown as data, never acted on.

## 18. Edge cases checklist

- Server only slow: probe passes, not offline.
- Captive portal or proxy page: body check fails, offline.
- Split DNS gives another host: `origin` pinned, held on mismatch.
- Auth expired while online: auth class, queue holds, "needs sign-in".
- Server maintenance (503 with `Retry-After`): open, probe honours it.
- Rate limited during replay: pause the drain, no attempt counted.
- Laptop sleeps and wakes: stale failures forgotten; first tick probes.
- Quit with items queued: persist; next session drains.
- Two sessions, one machine: one holder, keys make a double replay harmless.
- Two machines, one person: independent queues, similarity check catches near-duplicates.
- Person switches account: items held, never replayed as the new person.
- Queue full: loud refusal, nothing dropped.
- Agent loops on saves: per-session cap and local dedupe.
- Model supplies a huge or malformed field: refused at enqueue.
- Plugin downgraded or upgraded with items waiting: see 14.
- `$.store` over 4 MiB: queue budget leaves room; enqueue handles a rejected `set` as "not saved", loudly.
- Mod reload mid-drain: `sending` reconciled by key.
- Plugin setting `bab_url` has a trailing slash: existing warning; probe path built without a double slash.
- Headless run: works without UI.
- A held-for-review learn: never auto-confirmed. Someone must look.
- Every session started offline: nobody holds the `inbox` lease (it is taken only after a successful poll), so nothing drains until `$.mcp.connect` works or a session restarts. A session without a connection can still probe and mark `half-open`; closing and replay wait for a session that has one.

## 19. Open questions

1. What does `$.mcp.connect` do after a failed start (12)?
2. Is `$.store` safe across processes, and where and how is it written?
3. Does the stand-in namespace come out as `mcp__bab__...` on every surface? (The allow rule uses the names `$.tool.register` returns, so this affects wording only.)
4. Is MCP-level idempotency acceptable on the route (stored results include text a person wrote, kept 15 days instead of 24 h)? Should stored results be a minimal `{ id }` instead of the whole answer?
5. Is 50 entries and 14 days right? Defaults chosen to be small; adjust with real use.
6. Who owns the first maintainer dogfood group for the setting?
