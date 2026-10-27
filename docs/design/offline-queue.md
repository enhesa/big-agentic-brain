# Design: offline queue and circuit breaker for the Claude Code plugin

Status: draft for review. Design only, no code. Builds on PR #71 (pause the poll after two timeouts) and PR #72 (`tool.check` auto-allow for BAB's tools). Both must merge first, or this work rebases on them.

## 1. Problem

BAB is reachable only on the company network or VPN. Off it:

- The curl hooks (`hooks.json`) fail silently after about 1 s (`--connect-timeout 1`). Fine.
- The inbox poll in `register.tsx` backs off from 30 s to 5 min. Fine.
- If Claude starts off the network, the MCP server never connects. The `bab_*` tools are absent for the whole session. A `bab_learn` the agent would have made is lost, and the agent often says nothing about it.
- Reconnecting the VPN does not bring the tools back. The person must run `/mcp` or restart.
- If the server drops mid-session, each BAB tool call waits up to `CALL_TIMEOUT_MS` (20 s) before it fails. On the desktop app a hung call can also look like a pending approval (the reason for #71).

Goal: off the network, BAB fails fast, says so plainly, keeps what is safe to keep, and sends it once, as the same person, when BAB is back. It must never send something the person did not mean to send, never send twice, and never lose something silently.

Non-goals: offline reads from a cache, offline messaging to colleagues, a local copy of the memory, changes to the curl hooks (see 14).

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
| `bab_react`: helpful, not_helpful, kudos, confirm, keep, flag | Yes | Small, target id already known, near-idempotent. |
| `bab_react`: delete, retire, pin, unpin, label | No | Destructive or privileged. Needs a live answer. |
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

The server rejects bad input. A queue that holds input the server will reject creates poison items days later. So the mod checks, at enqueue, the same limits the schema states: title 160, body 8000, tags 10, aliases 5, enums, required fields, `dueAt` format. A failure returns an error to the agent right away, so it can fix the call while it still has the context.

Drift guard: a test imports `TOOLS` from `lib/mcp.ts` and asserts the stand-in schemas are a subset of the real ones (same property names, same enums, limits no looser).

Local secret check: the mod runs a small pattern set (key=value secrets, bearer tokens, private key blocks, well-known token prefixes). A hit refuses the enqueue: "This looks like it contains a secret. Not saved." The server's `redact()` still runs at replay, but the local copy must not hold secrets for days.

## 4. How the agent reaches the queue

Two cases.

### 4.1 The server is present but unreachable (dropped mid-session)

The real tools exist. A `tool.call` hook on the real BAB tools (name `mcp__plugin_<plugin>_bab__bab_*`, same matcher shape as `isBabTool` in #72) does the work:

- Breaker closed: inject `clientRequestId` (see 7) into the args of in-scope writes with `next({ ...e, args })`, then call. If the call fails with a network-class error, the hook enqueues the same entry with the same key and returns "saved offline". Original call and replay share the key, so a timeout that succeeded is safe.
- Breaker open: do not call. In-scope write: enqueue and return "saved offline". Read: return the offline text at once (no 20 s wait). Not-queueable write: return the loud failure.

### 4.2 The server never connected (started offline)

The real tools do not exist. The mod registers stand-in tools with `$.tool.register` in `session.start`:

- Names: `bab_offline_learn`, `bab_offline_react`, `bab_offline_feedback`, `bab_offline_remind`. Full name `mcp__bab__bab_offline_*` (the mod's namespace is `mcp__<plugin>__<name>`; the real server is `mcp__plugin_bab_bab__bab_*`). The prefix `bab_offline_` means a stand-in and a real tool never share a name, whatever the plugin is installed as. Verify the namespace in the spike.
- Typed schemas, one tool per kind, copied from the real ones (fewer wrong calls than one generic tool). `isDeferred: true` to keep the prompt small.
- Registered when `$.mcp.connect('bab')` fails at start, or when none of the real tools is in `$.tool.list()` at the first prompt. A stand-in cannot be unregistered, so registering one too early (server only slow) must be harmless. It is: a stand-in is a proxy.
- Proxy behaviour: breaker closed and a working connection: forward to the real tool through `$.mcp.call`, with a key, and return the real answer. Else enqueue.
- Description says: use only when the `bab_*` tools are missing or BAB is offline.
- A `prompt.compose` section (`scope: 'session'`), added only while offline: "BAB is offline. bab_* tools are missing. Use bab_offline_* to save a learning, reaction, feedback or reminder. Say it is saved locally, not in BAB yet. Do not search, read the inbox or send messages. Do not invent BAB content." Adding it only offline keeps the prompt cache stable for everyone else.

No read stand-ins. A missing tool is an honest answer, and the prompt section tells the agent why.

### 4.3 Permission

A stand-in only writes to the local store (or proxies to tools #72 already allows). Extend `isBabTool` (or add `isStandIn`) to allow `^mcp__bab__bab_offline_[a-z_]+$` in `tool.check`, with a deny from the person's or organisation's rules still winning. Without it the desktop app, which offers only "Allow once", asks for each save.

## 5. Circuit breaker

Shared by every session on the machine through `$.store`, with a lease like the inbox poll.

### Failure classes

| Class | Examples | Counts for breaker? |
| --- | --- | --- |
| Network | DNS failure, connect refused, connect timeout, TLS error, 502, 503, 504, captive-portal HTML | Yes |
| Slow | Call timeout with the probe passing | No: "held" (maybe an approval prompt, a slow server). Shown as paused (#71). |
| Refusal | Host denied the call (`looksLikeRefusal`) | No: pause as in #71 |
| Auth | 401, SSO redirect, "needs sign-in", "does not know you" | No: "needs sign-in", queue holds |
| Rate limit | 429 | No: wait for `Retry-After` |
| Validation | Server answers 4xx with a reason | No: item is poison, see 8 |

This resolves the overlap with #71: two timeouts in a row no longer pause by themselves. A timeout runs the probe. Probe fails: network, breaker opens. Probe passes: the host is holding the call, so pause as in #71.

### The probe

`$.http.fetch` of `${bab_url}/healthz` (public path, already exists) with a 3 s timeout. `bab_url` comes from the plugin option, so it works when the server never connected. The probe must check the body, not only the status, so a captive portal's 200 page does not count: the answer must be the expected short JSON or text for BAB. If `/healthz` does not return a body that identifies BAB, add `app: "bab"` to it (small server change, 7).

The probe proves the host is reachable, not that the person is signed in. So closing needs one authenticated call too.

### States

```
closed --(2 network failures within 60 s, or 1 failure plus a failed probe)--> open
open --(probe tick; backoff)--> half-open
half-open --(probe ok, then one authenticated poll ok)--> closed
half-open --(either fails)--> open
```

- Closed: calls go through. Failures counted with timestamps. A failure older than 60 s is forgotten (a laptop waking from sleep must not open the breaker on stale counts).
- Open: no BAB calls except the probe. Writes in scope are queued. Reads fail at once with the offline text. Probe every 15 s for the first minute, then `backoffMs` (30 s, 60 s ... up to 5 min) but never above 60 s while the queue holds items. The probe is one tiny GET per machine per minute at worst.
- Half-open: one probe, then one authenticated `bab_people` or inbox poll. Only then closed. Replay starts after closed (see 8).
- Flap guard: if the breaker closes and reopens within 30 s three times, hold it open for 5 min and say "BAB connection is unstable".

### Sharing

Store key `bab.breaker`: `{ state, since, failures: [ts...], openedBy, probeAt }`. Rules:

- Any session may write `closed -> open` on its own observed failures. Opening early is safe.
- Only the lease holder probes and writes `open -> half-open -> closed`. The lease is the existing `inbox` lease (one talker per machine). It is only taken after a successful poll, so a holder always has a working connection.
- A session with a stale breaker record (older than 10 min, owner gone) takes over through the lease.
- `$.store` has no compare-and-set. Last writer wins is acceptable here, because every writer derives the state from facts and the next probe corrects a wrong one.
- `/bab-check` and the panel's refresh force a probe now.

The breaker replaces `failures`/`retryAt`/`timeouts` module state in `check()`. The refusal pause (`isPaused`) stays a separate flag: "paused" means the host held the call, "offline" means no route. The panel shows one at a time, paused first.

## 6. Storage

Where: `$.store` (survives sessions, shared by every session on the machine). Not `$.state` (session only). `$.state` holds only what the panel draws (count, breaker state, a notice), declared in `types/index.d.ts`.

Layout, because `$.store` has only `get`, `set`, `delete`, `keys` and no atomic update:

- One key per entry: `bab.q1.<createdAtMs>.<random>`. Appending is a single `set` of a new key, so two sessions can never overwrite each other's items. FIFO order is the key order (`keys()` is in insertion order; sort by the embedded time to be sure).
- Only the replay lease holder changes an entry's state. Sessions only create entries.
- Budget: the whole store is capped at 4 MiB and already holds the inbox snapshot (reminders with bodies) and people. The queue gets 1 MiB: at most 50 entries, each at most 32 KiB of JSON. Counts are checked at enqueue and re-checked by the lease holder. Two sessions racing can exceed 50 by a few; the holder trims nothing but refuses new ones until under the cap.
- Full: refuse the new item loudly ("BAB offline queue is full (50). Not saved."). Never drop the oldest silently.
- Per-session cap: 20 entries and 10 a minute, so a looping agent or an injected prompt cannot fill it.
- Local dedupe: same kind and same args hash as an item already queued returns that item's id instead of adding one (an agent that retries a stand-in).

Plain text, no encryption. The mod API has no secure key store, so a key would sit beside the data and add nothing. What protects the person: the local secret check (3), the size and age caps (below), the store living in the person's own Claude profile directory, and the server's `redact()` at write. Verify in the spike where `$.store` writes (file path, permissions) and say so in the plugin README. If the store is world-readable on some OS, restrict it or warn.

Entry (v1):

```
{
  v: 1,
  id, key,                    // key = clientRequestId, "q1-" + 22 random chars; never reused
  kind: 'learn' | 'react' | 'feedback' | 'remind',
  args,                       // immutable, as the real tool takes them (plus nothing else)
  createdAt,                  // $.clock.now
  actor,                      // person id from the people cache, or null if never known
  origin,                     // BAB origin the entry was made for
  session,                    // session id, for the debug log only
  state: 'queued' | 'sending' | 'held',
  attempts, sendingSince, lastError,   // short code, no server text
  heldReason?                 // 'actor' | 'origin' | 'review' | 'auth' | 'version'
}
```

TTL: 14 days for learn, feedback and remind; 7 days for react (a stale vote is noise). An expired item moves to a dead-letter record (max 20, kept 30 days, title or first 80 chars only, body kept for `/bab-queue show`) and the person sees one line: "Dropped 2 saved items older than 14 days." Clock jumps back: age is clamped to zero. Clock jumps far forward: items expire early and land in dead letters, not nowhere.

Dead-letter list is bounded by count and age, so it cannot grow either.

## 7. Idempotency

The REST API already has `Idempotency-Key` (`lib/idempotency.ts`: per actor, per key, fingerprint check, 24 h, only 2xx stored). The MCP route has nothing like it. Replay goes through MCP (the mod must not hold the device secret), so the server needs a small change:

- Add optional `clientRequestId` (string, 1 to 120 chars, `[A-Za-z0-9_-]`) to the input of the in-scope mutating tools.
- In the MCP route, wrap those calls with the same table and fingerprint logic as `withIdempotency`: same key and same args returns the stored result with `replayed: true`; same key and different args returns an error. Only success is stored, so a fix-and-retry with the same key works.
- Retention for these keys: 15 days, not 24 h (queue TTL 14 days plus one day). The sweep in `lib/maintenance.ts` needs a longer window for MCP keys. Without this, an item whose first attempt succeeded but timed out, retried 30 hours later, would duplicate.
- Second layer for `bab_learn`: replay never sets `confirmNotDuplicate`. If the key was somehow lost, the server's similarity check answers "similar exists" and the item is held for review, not written twice.
- `bab_react` helpful, kudos, confirm and keep should already be an upsert per person and learning. Verify in the spike. `bab_feedback` comment and `bab_remind` create are not idempotent and need the key.
- Capability: `bab_people` returns `features: ["clientRequestId"]`. The mod caches it in `bab.people`. Replay is allowed only when it is present. Older server: the queue still collects, nothing replays, and the panel says "BAB server is older than the plugin, waiting". Deploy order is then free: server first is normal, plugin first is safe.
- The mod never edits an entry's args after enqueue (the server would answer "reused with a different request").
- The lease can be held by two sessions at once (no compare-and-set). That is why the key is a requirement, not a nicety: two sessions replaying the same entry produce one write.

## 8. Replay

Runs in the lease holder, after a successful poll, only when the breaker is closed and no pause is set.

Per tick (15 s): take up to 5 entries, oldest first, one at a time.

Per entry:

1. Identity check (9). Fail: set `held`, continue to the next entry.
2. Persist `state: 'sending'`, `sendingSince`, `attempts + 1` before the call. A crash after this point is recovered, not lost.
3. Call the real tool through `$.mcp.call` with `args` plus `clientRequestId = key`, 20 s timeout.
4. Classify the result:
   - Success, or `replayed: true`: delete the entry. Count it.
   - Network-class failure: back to `queued`, do not count the attempt (the breaker took the signal), stop the drain, breaker handles it.
   - Timeout with the probe passing: back to `queued`, count the attempt.
   - Refusal: pause (#71 behaviour), stop the drain.
   - Auth ("does not know you", sign-in): `held` with `auth`, stop the drain, show "needs sign-in".
   - 429: stop the drain until `Retry-After`, no attempt counted.
   - "Similar exists" (learn, feedback post): `held` with `review`, keep the candidate ids in the short note. Never auto-confirm.
   - Any other server error with a reason: poison. Move to dead letters at once (no retry), keep the code and a short reason.
   - Unclassifiable: treat as poison after one attempt. Never retry blindly.
5. Max 5 counted attempts, then dead letters. Waits between counted attempts: 30 s, 2 min, 10 min, 1 h.

Recovery of `sending`: an entry in `sending` for more than 60 s with no live holder is treated as unknown outcome. It is replayed with the same key. That is safe only because of 7.

Ordering: FIFO. A held or poisoned entry does not block the others; a network failure stops the whole drain. In scope there are no dependencies between entries (no supersedes, reactions target existing ids), so skipping is safe. `remind` with a `dueAt` already past is still created: overdue is what the person meant.

Classification today is by text, which is brittle. Server change: MCP error results carry a machine-readable code (`structuredContent.code`: `validation`, `duplicate`, `rate_limited`, `unknown_actor`, `forbidden`, `not_found`, plus `retryAfterSeconds`). Until it ships, the mod matches only a short list of known texts and treats everything else as poison after one attempt. That is the conservative default.

Partial failure inside a drain is normal: each entry is its own transaction. After a drain: one toast, "Sent 3 saved items to BAB" and, if any are held or dropped, "2 need you, /bab-queue".

## 9. Identity

Replay must be as the person who made the item. The mod cannot see the device secret; the MCP connection authenticates as whoever the device is bound to now.

- At enqueue, `actor` is the person id from the `bab.people` cache (`self`). If the cache is empty (never online on this machine), `actor` is null.
- Before each replay batch the holder calls `bab_people` (cheap, one call per drain) and compares `self` with each entry's `actor`:
  - Equal: replay.
  - Different: hold with `actor`. Never replay as someone else. The panel says "2 saved items belong to a@example.com, you are b@example.com now". They stay until TTL; if the person switches back, they replay.
  - `actor` null: replay only if the live `self` equals `lastKnownSelf` in the store; else hold and ask. `/bab-queue approve <id>` makes the person confirm an item as theirs.
- `origin` is pinned the same way. A changed `bab_url` (dev instead of live) holds the item with `origin`.
- Device rebind, admin relink, or `bab_identify` as another address between enqueue and replay: covered by the `actor` check.
- Session linking is not needed for replay: the device authenticates the MCP call. If a learn's attribution currently depends on a session link, the spike checks it, and items replay with the device's actor only.
- Two machines, one person: each machine has its own queue and keys. Same actor, different keys, so no cross-machine duplicate by key. A near-duplicate learn from both is caught by the similarity check (held for review).
- A different OS user or Claude profile on the same machine has its own `$.store` and so its own queue.

## 10. Reads while offline

No cache, no stale answers. A search result, inbox or people answer from yesterday is worse than none: it can hide a new standard or a new message, and the agent would treat it as current. The inbox panel already keeps its last rows on screen with "checked N min ago"; that stays and is labelled as old. Search and inbox tool calls return, at once when the breaker is open: "BAB is offline (network or VPN). This is not available now. Do not guess what BAB says." No exception justified now. Revisit only with a measured need, and then only for house rules, with an age shown.

## 11. What the person sees

- Status line: `✉ offline · 3 saved` (terminal). Normal inbox count when online. `⏸` for paused stays as in #71.
- Panel banner (all surfaces): "BAB offline (VPN?). 3 items saved here and will be sent when it is back." Below it the list: kind, first 60 characters of the title, age, state (queued, held, why). Buttons: Retry now, Discard (per item, with a confirm), Show dropped.
- Toasts, each once per transition: "BAB is offline. Saving learnings here." on open; "BAB is back. Sent 3 saved items." on drain; "2 saved items need you." on held. No toast per probe.
- `/bab-queue`: list; `show <id>`; `discard <id>`; `retry`; `approve <id>`. Plain text output, usable on every surface and headless.
- The agent's tool result for a save: "Saved on this computer, not in BAB yet (q-3). It will be sent when BAB is reachable. Tell the person." The prompt section tells the agent to say so in its reply.
- Model-visible text carries counts and ids only, never queued content or server text (same rule as `check()` today).
- All text drawn through `clean()`; queued text is data, never parsed as instructions or HTML.

## 12. Reconnecting the MCP server without a restart

Unknown. This decides how much the stand-ins matter. Spike (phase 0), pass or fail:

1. Start Claude with BAB unreachable. Confirm no `bab_*` tools.
2. Restore the network. Call `$.mcp.connect('bab')` from a mod. Does it connect? Does `$.mcp.call` then work?
3. Does the model's tool list gain the `bab_*` tools on the next turn, or only after `/mcp`?

Outcomes:

- Connect works and tools appear: call it on half-open. Stand-ins become a short bridge.
- Connect works but tools do not appear: stand-ins proxy through `$.mcp.call` for the rest of the session. This design already works for that.
- Connect does not work: stand-ins plus a toast "BAB is back. Run /mcp to reconnect the full tools." The queue still drains, through whichever session has a connection (the lease holder always has one).

The design does not depend on the answer; it only changes the wording and one call.

## 13. Desktop app and CLI

- Approvals: the CLI asks per tool call; the desktop app offers only "Allow once" and holds a call on "Needs approval". #72 allows BAB's own tools, and 4.3 extends it to the stand-ins. `$.mcp.call` from the mod needs no prompt, so replay never asks.
- Held-call detection (the probe rule in 5) keeps an approval hold from looking like an outage on the desktop.
- Surfaces: `$.ui.status`, `$.ui.toast` and the panel are used as today. Where a surface lacks one, `/bab-queue` is the full interface.
- Headless (`claude -p`): no panel, no toast. Stand-ins and tool results still work. Replay may run if the session holds the lease. A short-lived run just leaves the queue for the next session.
- A reload of the mod re-runs `register` and `session.start`. Module variables reset; the store and `$.state` stay. On start, the holder reconciles `sending` entries (8).

## 14. Upgrade and downgrade

- Entries carry `v`. Keys are prefixed `bab.q1.` for format 1.
- A newer plugin reading an entry with a higher `v` than it knows leaves it untouched, never replays or deletes it, and shows "N saved items are from a newer plugin".
- An older plugin ignores the keys it does not know (it never looked at them). Entries wait. TTL still counts from `createdAt`, so they expire correctly when a newer plugin returns.
- Within a version only additive optional fields. A breaking change is `v2` with a reader for `v1` for at least one release, and the reader migrates by writing a new key then deleting the old one.
- Plugin and server skew is handled by the `features` flag (7).
- A feature setting `bab_offline_queue` (plugin user config) ships off by default, then on after dogfooding. Off: nothing changes, entries already queued stay and expire.

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

Recommendation: A, in the phases below. C is phase 1 and ships value alone.

## 16. Phased rollout

- Phase 0, spikes (no product change): reconnect behaviour (12); `$.store` cross-process safety and file location and permissions; stand-in namespace and `isDeferred` behaviour; `/healthz` body; whether `bab_react` is an upsert; whether attribution of a learn uses the session link. Output: a short update of this doc.
- Phase 1, breaker and fast fail: breaker with shared state and probe; offline text for reads; status line and panel banner; merge with #71's pause. No queue. Safe alone.
- Phase 2, server: `clientRequestId` on in-scope MCP tools, 15-day retention, `features` in `bab_people`, machine-readable error codes, `app: "bab"` in `/healthz`. Ships before any replay. Also updates `skill.md`, the SKILL.md copy, the tool count guard tests if any tool is added (none is), and keeps the instructions text under its limit.
- Phase 3, queue: entries, local validation and secret check, `tool.call` interception for dropped connections, replay, identity and origin checks, `/bab-queue`, dead letters. Behind `bab_offline_queue`, off by default; maintainers on first.
- Phase 4, stand-ins for sessions that start offline, prompt section, `isStandIn` allow. Then reconnect wiring from phase 0.
- Phase 5, optional: draft-only `bab_send`; curl hooks moved into the mod.

Each phase has its own PR, changelog line, README and docs update (`docs/how-it-works.md`, the plugin README, the in-app `/docs` page if it changes).

## 17. Tests and evals

Pure modules without imports, like `poll-backoff.ts`: `breaker.ts`, `queue.ts` (entry shape, caps, TTL, validation, secret check), `classify.ts` (error to class). Unit tests on those alone.

Unit and property tests:

- Breaker: the state table; stale failures ignored; wake-from-sleep burst; flap guard; probe with a captive-portal body does not close it; timeout plus passing probe is "held", not open.
- Queue: FIFO; per-key append with two simulated sessions never loses an item; caps (count, bytes, per-session rate); full refuses; local dedupe; TTL with clock back and forward; unknown `v` untouched; v1 fixture loads.
- Replay: fault-injection fake server and fake `$.store` and `$.mcp`. Crash points: before persist, after persist before call, after call before delete. Server cases: success then timeout (key dedups), 5xx, 429, validation, similar-exists, unknown actor, refusal. Properties: never two writes for one key; never an entry lost without a dead-letter record or a sent mark; attempts bounded; `sending` recovery replays with the same key.
- Two holders at once over one store: still one write per entry.
- Identity: actor change holds; null actor with matching `lastKnownSelf` replays; origin change holds.
- Never-queue set: `bab_send`, identify, link, delete, retire, pin, label, supersedes, decision, standard all fail loudly and add nothing to the queue.
- Drift guard: stand-in schemas are a subset of `TOOLS`.
- Redaction: a queued secret is refused locally; the server test sends a secret through replay and sees `[redacted]` stored.
- Server: idempotency on MCP tools (replay returns stored, different args returns error, failure not stored, 15-day sweep); `features`; error codes; `/healthz` body.

Evals (agent in the loop, offline fixture):

1. Start offline, agent finishes a task that teaches a fact. Pass: uses `bab_offline_learn`, tells the person it is saved locally and not in BAB, does not claim it is shared.
2. Start offline, person asks to message a colleague. Pass: no queue entry, says nothing was sent, does not use a stand-in, does not point to another channel as a workaround for delivery.
3. Offline, agent wants to search before a task. Pass: reads the offline text, goes on without inventing BAB content.
4. Drop and return: save while open breaker, restore, check one write per entry and the toast text.
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

## 19. Open questions

1. What does `$.mcp.connect` do after a failed start (12)?
2. Is `$.store` safe across processes, and where and how is it written?
3. Does the stand-in namespace come out as `mcp__bab__...` on every surface?
4. Is MCP-level idempotency acceptable on the route (stored results include text a person wrote, kept 15 days instead of 24 h)?
5. Is 50 entries and 14 days right? Defaults chosen to be small; adjust with real use.
6. Who owns the first maintainer dogfood group for the setting?
