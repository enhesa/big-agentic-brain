# Command Center

Command Center is a private page, `/command-center`, where a person sees what their own agent
sessions are doing: initiatives with progress, open questions with their age, the health of
recurring upkeep, links, and a short log of what was worked on. Agents push the state; the page
only shows it. The log is the person's own record of effort per initiative: what each turn did,
with the server's time, which the person can download.

The page is hidden: it has no navbar or footer entry. The command-center skill gives the person
the link.

## Opt-in on both sides

- The person switches it on and off on the page, signed in through the sign-in proxy. No agent can
  flip the switch: the page routes take the viewer only, and `POST /api/me` ignores a
  `commandCenter` field.
- The server stores nothing for a person whose switch is off. A write or read answers 403:
  "Command Center is off for <name>. Ask them to open <origin>/command-center and switch it on,
  then publish again. Nothing was stored."
- Agents publish only when the optional `command-center` skill is installed (the
  `plugins/command-center` plugin, also served at `/instructions/command-center.md`). The BAB
  plugin's own skill only names the tool.
- Turning it off keeps the records and the log 30 days (switch on again to restore them), then
  deletes them. It also withdraws every export grant at once. "Delete all my records now" deletes
  records, log and export grants at once.
- `BAB_COMMAND_CENTER=false` switches the feature off for the whole deployment.

## API

One lib (`lib/command-center.ts`) behind one MCP tool and the REST routes.

| MCP `bab_command_center` action | REST |
| --- | --- |
| `publish` (the whole record, optional `worked`, `size` and `expectSeq`) | `PUT /api/command-center/<id>` |
| `list` | `GET /api/command-center` |
| `list` with `id` (the full record, owner only; 404 for an unknown id) | `GET /api/command-center/<id>` |
| `remove` (`id`) | `POST /api/command-center/<id>/actions` |

`POST .../actions` takes an `Idempotency-Key`. A `PUT` is idempotent by nature.

The v2 actions `comment`, `health` and `clear_question` are gone for agents. Each answers a 400
that names the fix: `worked` on the next publish, `health` as a field of the recurring record, and
leaving an answered question out of the next publish. The person's Dismiss on the page stays.

The MCP tool declares only `action`, `id` and `record`. Agents send the record, with `worked`, as
one object in `record`. `action` and `id` go beside `record`, not inside it; the ones inside are
ignored, and a publish without a top-level `id` is a 400. A `record` that is not an object is a
400. Some clients send undeclared fields as strings, so on the MCP path only a numeric string `v`
or `expectSeq` and JSON text for `tasks`, `questions`, `options`, `links`, `health` and `source`
are read (`null` clears `health`); text that does not parse is a 400 naming the field. REST stays
strict and refuses a `record` field.

Only a bound identity is served: the BAB plugin's device, the sign-in proxy, or an API token bound
to the person. An identity sent only in headers is refused. The owner of every record is the
resolved identity, never a body field. Nobody can read another person's records or log.

## The record

The record format, with every limit, is in the skill: `content/instructions/command-center.md`.
In short:

- `v: 1` is required. Unknown fields are refused with the allowed list. Too long is 400; nothing is
  cut short. Text that looks like a secret or personal data is refused and the field is named.
- At most 100 initiatives and 256 KB per person, 32 KB per record (413), 256 KB per request.
- The server owns every time except `health.checkedAt`: `updatedAt`, `seq`, a question's
  `askedAt` and `clearedAt`, a task's `startedAt` and `finishedAt`, health `receivedAt`, and the
  time of every log entry. Clock skew between machines never shows.
- `expectSeq` that does not match is 409 with the current record, unless the record you send is
  already exactly the current one (a retried request): that is `unchanged: true`, not a 409.
- A 409 answer includes the current record: merge it and publish again. REST returns it as
  `current`; the MCP tool puts it in the error text after `current: `, because an MCP error is text only.
- Publishing the same record again changes nothing (`unchanged: true`): no new `seq` or audit row.
  A new `worked` line on it is still logged, and the answer carries its id in `logged`.
- Leaving out `health` on a recurring initiative keeps it; `null` clears it. A `comments` field is
  refused with a pointer to `worked`.
- A question left out of a publish is cleared. A question the person dismissed on the page stays
  cleared while the agent sends the same id and text; the answer lists it in `dismissed`. A
  dismissal moves neither `seq` nor `updatedAt`.
- Cleared questions are kept 7 days, at most 20 per initiative.
- 60 calls a minute and 20 at once per person, on top of the general limit.

## The work log

`worked` is one line (at most 200 characters, no line break) on what the turn did; `size` is an
optional `small`, `medium` or `large` beside it, never a time estimate. Neither is stored in the
record. The server writes each `worked` line to the log with its own time, the initiative id, title
and key, and the `source` machine and session. It also logs what it sees by itself: a task started
or done, a question asked or cleared (also by the person's Dismiss), a health level change and a
state change.

Entry ids are stable, so a retry is a no-op. The `worked` entry of a publish is fixed by the `seq`
it produced. On an unchanged record, a line that repeats the session's newest line for that
initiative is not logged again, and the answer gives the same `logged` id. Derived entries are
fixed by their task, question or health and its server time. A 409 logs nothing.

## Export

- The person downloads their own log on the page (`GET /command-center/export`, the signed-in
  viewer only, audited `cc_export_own`).
- `BAB_COMMAND_CENTER_EXPORT_APPS` lists report apps as `app=token`; the token carries the export
  scope and nothing else. An app reads `GET /api/command-center/export` with that token as a
  bearer, only for people who granted that app on their own page and whose switch is on. The
  person grants or revokes each app on the page (same-origin viewer posts, audited
  `cc_export_grant` and `cc_export_revoke`). Every app read is audited (`cc_export_app`).
- Aggregated by default: counts per initiative and UTC day (entries, `worked` lines, sizes) with the
  initiative's title and key, but no log lines and no session. `detail=entries` returns the entries only for people who granted the
  `entries` level. `from` and `to` are dates, at most 400 days apart; the default is the last 92
  days.
- `/api/command-center/export` is a public path for BAB's own API token gate, because the app token
  is the credential. A sign-in proxy in front of BAB has its own public-path list: add the path
  there too, or apps cannot reach it.

## Derived flags

- A question is possibly stale when it is older than 3 days, its initiative is done or parked, or a
  later publish from another `source.session` kept it.
- An active initiative with no write for 14 days is silent: it leaves the page.
- Recurring upkeep is overdue when its health is older than 26 hours (daily, the default), 8 days
  (weekly) or 2 hours (drain). Unknown is never overdue.
- `priority: paused` hides the initiative's questions and counts nothing as stale or silent.
- The list answer and the page header carry a data-health summary: stale questions, silent
  initiatives, upkeep without health, overdue upkeep.

## Storage

SQLite is the one store (migration 54): `command_center_initiatives` holds the live records,
`command_center_log` the log, `command_center_export_grants` the person's consent per app. Every
query is keyed by the owner. Each write runs in one transaction from its first read to its last
write, so there is no lease, no snapshot and no need to republish after a restart.

Moving from v2: at start, an existing `DATA_DIR/command-center-snapshot.json` is imported once.
Every record is checked as strictly as a new publish, broken ones are dropped and counted in the
log, a record already in SQLite is never overwritten, and v2 comments become `note` log entries at
their own time. The file is then renamed to `command-center-snapshot.imported.json` and its sha256
is recorded, so it is never imported twice. The renamed file is kept 30 days, then deleted. To roll
back to v2 within those days, rename it back; v2 ignores the new tables.

The opt-in switch is two columns on `users`.

Retention, one rule each: the page shows active initiatives that are not silent; done, parked and
silent ones stay in `list` and in the log. A live record goes 30 days after its last write. The log
is kept `BAB_COMMAND_CENTER_LOG_DAYS` days (default 400). People switched off for 30 days lose
records, log and grants. Cleared questions stay 7 days. Writes are audited (`cc_publish`,
`cc_clear`, `cc_remove`, `cc_enable`, `cc_disable`, `cc_delete_all`, and the export rows above)
with the person, the initiative id and the result, never the text.

## The page

`app/command-center/page.tsx` renders for the signed-in viewer only, as a dense dashboard that
uses up to 1400 px on wide screens. The header is one line: title, the On pill, the last push and
the data-health chips, which turn amber or red when not 0. Switch off and Delete sit in a
settings menu; Delete asks for a confirm first.

- Needs you: short question cards, oldest first, about four per row on a 1440 px screen: the
  question, one meta line with the initiative, a possibly-stale tag and the age, then the options
  as small pills (display only) beside Dismiss. A left bar marks urgent and high priority. With
  none, an All clear card.
- Initiatives: one masonry flow of compact cards (CSS columns: four at 1280 px and up, three at
  1024, one on phones), grouped by area with the area name as a small heading inside the flow,
  ordered urgent, high, none, low, paused. Small areas share columns, and an opened card grows in
  place without stretching its neighbours. Each card has state, priority, key and deadline tags
  (near and overdue in words, days counted on UTC dates), a progress ring with the percent inside
  beside the title, the task in progress on one line, and one meta line with a toggle that opens
  the task list and a small Log of the latest entries, links as pills with their host, and who
  pushed last. Paused cards have grey chrome and a label; their text keeps full contrast.
- A line counts the done, parked and silent initiatives that left the page.
- Your log: the download link for the person's own log, and each configured export app with
  Grant or Revoke.
- Recurring upkeep: one line each with a health dot and label, the reason (cut short, full text in
  its tooltip; wrapped on phones), when it was checked and an overdue tag.

Every agent string is React text, never HTML; a link shows its host, and its full URL is its title. Colours are tokens on
the page, with dark values for `data-theme="dark"`, like /usage. Motion honours
`prefers-reduced-motion`.

The open page polls `/command-center/state` every 15 seconds while the tab is visible and
refreshes when the stamp changed. It does not use `/api/events`, which is public.

## Evals

`pnpm eval:cc-contract` replays a recorded agent session over MCP against a fresh BAB and checks
every answer and the stored state; it runs on pull requests. `pnpm eval --suite cc` and
`--suite cc-trigger` run an LLM agent through multi-turn scenarios with the skill text or only its
description, and report a pass rate per scenario. The behaviour suite grades that every turn ends
with a publish that carries `worked`. See [evals/README.md](../evals/README.md).
