# Regression test map

Quick lookup: feature area → test file(s) that cover it.

The web UI (`/memory`, `/memory/[id]`, `/conversations/[threadId]`)
is read-only. All writes happen through the JSON agent API under `app/api/**`.

## The hook is `GET /api/hook`, and nothing else

There is no script on anyone's machine: no `hook.mjs`, no `listen.mjs`, no `guard.mjs`, no
Node, no background process. Both Claude Code hooks are a bare `curl` at this one route,
so everything the old scripts decided locally the server now decides here, and
`api-hook.test.ts` is the only thing standing between a change and every installed
session. Three ways to break it, all of them silent on the server side:

- **Naming the wrong event.** A bare `curl` never sees the JSON Claude Code puts on
  stdin, so the caller names its event in `?event=` and the route echoes it back. Claude
  Code rejects an envelope naming any other event, so returning a fixed `SessionStart`
  puts `Hook returned incorrect event name` on every prompt in every installed session
  (9ce5af4). Echo only from the allowlist, and fall back to `SessionStart`.
- **Erroring instead of staying quiet.** No identity means `{}` and HTTP 200. A 401 here
  is an error banner for everyone who has not finished installing.
- **Dropping the version line.** It is how an out-of-date machine learns to re-install,
  and `install.md`'s own sha256 is what bumps that version, so an edit there is a release
  to every installed machine, not a docs change.

| Feature area | Test file(s) |
|---|---|
| `GET /api/learnings`, `POST /api/learnings` (create + supersede + dedup 409/confirmNotDuplicate) | `api-learnings.test.ts`, `api-learnings-post.test.ts` |
| `GET /api/learnings/[id]` | `api-learnings-id.test.ts` |
| `POST /api/learnings/[id]/vote` | `api-learnings-vote.test.ts` |
| `POST /api/learnings/[id]/flag` | `api-learnings-flag.test.ts` |
| `POST /api/learnings/[id]/kudos` | `api-learnings-kudos.test.ts` |
| `GET /api/learnings/similar` (duplicate pre-check, never 409s) | `api-learnings-similar.test.ts` |
| `GET /api/learnings/duplicates` (existing near-duplicate pairs) | `api-learnings-duplicates.test.ts` |
| `GET /api/todos`, `POST /api/todos` | `api-todos.test.ts` |
| `GET /api/todos?tab=overdue\|due_soon\|open\|done` (the standalone `/api/todos/due` route is gone) | `api-todos.test.ts` |
| `POST /api/todos/[id]/complete\|snooze\|abandon` | `api-todos-actions.test.ts` |
| `GET /api/inbox`, `GET /api/inbox/[threadId]` (incl. participants, caller `lease`, per-message `fromName`/`toName`) | `api-inbox.test.ts` |
| `POST /api/inbox/[threadId]/lease` (chat lease: record, clamp, 404/403) | `api-inbox-lease.test.ts` |
| `POST /api/messages` | `api-messages.test.ts` |
| `POST /api/messages` live-chat wiring (`kind`, `X-Bab-Lease`) | `api-messages-live-chat.test.ts` |
| `GET /api/people` | `api-people.test.ts` |
| `GET /api/me`, `POST /api/me` (deliberate, audited rename) | `api-me.test.ts` |
| `GET /api` (endpoint index) | `api-index.test.ts` |
| Instructions routes (`/instructions`, `install.md`, `skill.md`, `version`) | `instructions.test.ts`, `instructions-routes.test.ts` |
| `GET /api/hook`, the entire hook (unread digest, cap 3, own messages excluded, version notice always present, `{}` and never an error without identity) | `api-hook.test.ts` |
| `GET /api/hook` envelope names the event that fired (`?event=` echoed from an allowlist, `SessionStart` when absent or unrecognised) | `api-hook.test.ts` |
| `POST /api/hook`, the plugin's http hook (unlinked session mints/reuses a link token, linked session gets an unread count + `bab_inbox` pointer only, per-session-per-message dedup, malformed/non-object body and any throw still 200 `{}`) | `api-hook-post.test.ts` |
| `flaggedStandardsWaiting` and the maintainer hook line (a flagged standard or decision waits until a maintainer confirms, keeps or restores it after the newest flag; once per session; the `keep` audit row and the confirm renewal after a flag) | `learnings-flagged-standards.test.ts`, `api-hook-post.test.ts`, `learnings.test.ts` |
| `bab_people` `maintainers` from `BAB_MAINTAINERS` (sorted, named from the directory or the address; empty while unset) and the texts that point at it | `mcp.test.ts`, `instructions.test.ts` |
| `POST /mcp`, JSON-RPC 2.0 (`initialize`, `notifications/initialized`, `tools/list`, `tools/call` for all eight tools, identity failure → `-32001`, rate limit → `-32029`, unknown tool/method errors, `bab_link_session` token redemption) | `mcp.test.ts` |
| Devices (`lib/devices.ts`: secret hash, connect nonce single use / expiry / reuse / limit, lookup throttle, revoke, label), identity order device > headers, `Authorization` ignored, unknown device on `/mcp` (fixed not-connected text, header tip, kill switch `BAB_DEVICES=0`) | `devices.test.ts`, `device-session.test.ts`, `mcp-device.test.ts`, `session.test.ts` |
| `/connect/<nonce>` (auto-bind linked and by suggestion, typed claim, expired / spent / invalid), `/me/devices` (list, revoke, unlink revokes devices, claim), `/admin/links` devices, `/me/token` redirect, `sameOrigin` on every POST | `connect.test.tsx`, `me-devices.test.tsx`, `admin-devices.test.ts` |
| `/docs` claims still match the code (no background process, no script to install) | `docs-page.test.ts` |
| `POST /api/messages` `request` (collaborative request flag) | `api-messages-request.test.ts` |
| `lib/project.ts` (`normalizeProjectKey`, project on create, project filter in list/search, `listProjects`, v9 backfill, company-wide learnings) | `project.test.ts` |
| `POST /api/learnings` with project, `GET /api/learnings?project=`, `GET /api/projects` | `api-projects.test.ts` |
| `/memory` project chip distinct from tags, `/memory/[id]` project in byline, filter combinations | `memory-project-ui.test.ts` |
| `lib/stats.ts` (`liveNumbers`, `topTags`, `topProjects`, `topAuthors`) | `stats.test.ts` |
| Landing and inner navbars keep identical links, no call-to-action pill | `nav-consistency.test.ts` |
| Graceful shutdown (SIGTERM handling) | `shutdown.test.ts` |
| `lib/learnings.ts` (create/search/vote/flag/kudos/supersede/keep, valid-until date) | `learnings.test.ts`, `learnings-gaps.test.ts` |
| Agent reads (`touchRead`: search results, fetch by id, helpful/confirm/kudos/keep; not web pages; once a day), no default expiry, the valid-until date, the inactivity sweep (365 days, exemptions, clock start), `auto-archive` audit rows, migration v40, usage upkeep | `agent-reads.test.ts`, `learnings-reaction-reads.test.ts`, `maintenance.test.ts`, `db.test.ts`, `usage.test.ts` |
| `lib/learnings.ts` restore (`keep` on an archived memory: note rules, inactivity clock restart, what stays refused) | `learnings-restore.test.ts`, `mcp.test.ts` |
| `resolveProjectFromCwd` (worktree folders, 5-minute per-folder memory, plain folders never read the projects) | `project-canonical.test.ts`, `api-hook-post.test.ts` |
| BAB is an honour system: the server accepts a standard from a non-maintainer, a supersede of another's decision and a retire of another's standard (the texts guard these, by design; do not rebuild a refusal) | `honour-system.test.ts` |
| `POST /api/hook` retire nudge for the author (colleague's retire in the last 7 days, once per owner and retire, ends with a restore) | `api-hook-post.test.ts` |
| `lastRetire`: the latest retire or restore (who, when, why) on the memory page, `GET /api/learnings/:id`, search hits and `bab_search`; not among `recentNotes` | `learnings-last-retire.test.ts`, `learnings-retire-by-anyone.test.ts`, `memory-kind-ui.test.ts`, `mcp.test.ts` |
| `lib/standing.ts` and `standingsFor` (standing carried down a chain of corrections) | `standing.test.ts`, `learnings-correction-carry.test.ts` |
| `lib/learnings.ts` (`findSimilar`, dedup guard in `create()`, `confirmNotDuplicate` audit trail) | `learnings-dedup.test.ts` |
| `lib/similarity.ts` (tokenizer, jaccard, weighted score, thresholds) | `similarity.test.ts` |
| `lib/todos.ts` (create/list/complete/snooze/abandon, ownership) | `todos.test.ts`, `todos-gaps.test.ts` |
| `lib/messages.ts` (send/thread/markRead/inbox/participant checks) | `messages.test.ts`, `messages-gaps.test.ts` |
| `lib/messages.ts` live chat (`kind:auto` rules, `recordLease`/`getLeaseForActor`/decrement/refusal) | `messages-live-chat.test.ts` |
| `lib/rate-limit.ts` (`checkWaitRateLimit`/`beginWait`/`endWait`: 60/min + 6 concurrent, independent of the general limiter) | `rate-limit.test.ts` |
| `lib/messages.ts` (`listAllThreads`, `threadForViewer`, the open, human-facing Conversations browser) | `conversations.test.ts` |
| `lib/relative-time.ts` (relative time formatting for the Conversations browser) | `relative-time.test.ts` |
| `lib/events.ts` (in-process bus: emit/subscribe/unsubscribe, ring buffer cap, replay after seq, snippet truncation) | `events.test.ts` |
| `GET /api/events` (SSE: headers, replay via Last-Event-ID/`?since=`, topic filter, ping comment, 503 at the concurrency cap) | `api-events.test.ts` |
| Event emission from each lib write path (learnings create/vote/flag/kudos/supersede/auto-archive, messages send/markRead, todos create/complete/snooze/abandon, users setPresence) | `events-emission.test.ts` |
| `LiveUpdates` wired into `/memory`, `/memory/[id]`, `/conversations/[threadId]`, the Users section of `/usage` | `live-updates-pages.test.tsx` |
| `app/conversations/[threadId]/page.tsx` (render: escaped message bodies, auto-reply tag) | `conversations.test.ts` |
| `lib/users.ts` (upsert keeps first-seen name, `name_mismatch` audit, first-sight derived-name-from-email + `name_from_email` audit for long-form @example.com addresses, `renameUser`, directory, learning counts) | `users.test.ts` |
| `lib/session.ts` (identity resolution: forge > agent headers, rate limit, long-form-only @example.com email, short-alias rejection message) | `session.test.ts`, `session-precedence.test.ts` |
| `lib/identity.ts` (`derivedNameFromEmail`, `namesMatchLoosely`, long-form email regex) | `users.test.ts` |
| `lib/idempotency.ts` (key normalization, store/replay, `withIdempotency`) | `idempotency.test.ts` |
| `lib/rate-limit.ts` (120/min per actor, window reset, per-actor isolation) | `rate-limit.test.ts` |
| `lib/request-audit.ts` (audit row writing, optional/anonymous actor, never throws) | `request-audit.test.ts` |
| `lib/redact.ts` secrets (bearer, JWT, PEM, URL creds, AWS/Azure/vendor keys, key=value) | `redact.test.ts`, `redact-gaps.test.ts`, `redact-pii.test.ts` |
| `lib/redact.ts` personal data (non-Acme emails, phones, Luhn cards, IBAN mod-97, national IDs) + false-positive guards (SHAs, dates, Jira keys, versions, epochs) | `redact-pii.test.ts` |
| Redaction applied to display names; hourly sweep re-redacts stored rows under new patterns | `redact-pii.test.ts` |
| `lib/dates.ts` (calendar date helpers) | `dates.test.ts` |
| `lib/db.ts` (migrations, FTS) | `db.test.ts` |
| `app/healthz` | `healthz.test.ts` |
| `app/components/shell/Shell.tsx` (read-only, no identity block) | `shell.test.tsx` |
| Landing page | `landing.test.tsx` |
| Indexes used (no full table scans) + p95 latency at seeded scale (5k learnings/500 users/20k messages/5k todos/50k audit rows) | `perf.test.ts` |
| `lib/maintenance.ts` (retention sweep: idempotency 24h, audit_log 180d, hourly guard, never throws) | `maintenance.test.ts` |
| `lib/sessions.ts` (linkSession owner guard and id cap, quiet stale refresh, sweepSessions) | `sessions.test.ts` |
| `POST /api/messages` and `bab_send` are inbox only (`toSession` ignored, refused alone; a note to yourself works) | `api-messages.test.ts`, `mcp.test.ts`, `messages-gaps.test.ts` |

## E2E (real HTTP against the standalone server)

`vitest.e2e.config.mts` / `pnpm test:e2e`. Global setup (`tests/e2e/global-setup.ts`) builds (unless
`.next/standalone` is fresh or `E2E_SKIP_BUILD=1`), copies `.next/static` and `public/` next to
`server.js` like the Dockerfile runtime stage, boots it on a free port with a throwaway `DATA_DIR`,
and waits for `/healthz`. `tests/e2e/helpers.ts` has the shared fetch client and the two long-form
test identities (`alice.example@example.com`, `bob.example@example.com`).

| Feature area | Test file(s) |
|---|---|
| Identity (401 missing/short-alias, 200 long-form, name not overwritten by mismatch) | `identity.e2e.test.ts` |
| Learnings (create, idempotent replay, dedup 409/candidates/confirmNotDuplicate, similar never-409s, search escaping, vote changed true/false, flag-twice archive + status=all, supersede two-way, kudos then 409, self-vote 403) | `learnings.e2e.test.ts` |
| Todos (create, due_soon, complete/complete-again 409, cross-owner 403/404) | `todos.e2e.test.ts` |
| Inbox/messages (send, reply without `to`, thread read marks read, non-participant 403) | `inbox.e2e.test.ts` |
| Leases (record/decrement/refuse at 0), rate limit (429 after 120 fast GETs) | `leases-ratelimit.e2e.test.ts` |
| Instructions routes (install.md/skill.md/version: status, content type, origin substitution) | `instructions.e2e.test.ts` |
| Read-only UI (`/`, `/memory`, `/memory/[id]`, `/conversations/[threadId]`, `/conversations`, `/people` and `/board` redirects; no `<form`) | `readonly-ui.e2e.test.ts` |
| `GET /api/events` SSE (skips with a TODO if the route doesn't exist yet, concurrent feature work) | `events.e2e.test.ts` |
