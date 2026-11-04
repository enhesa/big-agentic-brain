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
| `backfill_link` (a single-use upload link, see Backfill) | `POST /api/command-center/backfill/<token>` takes the upload |

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
or done, a question asked or cleared (also by the person's Dismiss), a health level change, a
state change, and `synced` when a backfill upload created the initiative from its `current` state.

Entry ids are stable, so a retry is a no-op. The `worked` entry of a publish is fixed by the `seq`
it produced. On an unchanged record, a line that repeats the session's newest line for that
initiative is not logged again, and the answer gives the same `logged` id. Derived entries are
fixed by their task, question or health and its server time. A 409 logs nothing.

## Backfill from old sessions

A person can fill their log with work done before they used Command Center, from the agent
session transcripts on their own machines. To draft the lines, a masked excerpt of each work block
(at most 4000 characters, with secret-shaped strings, email addresses and backfill links replaced
by `[redacted:<kind>]`) goes to the model endpoint the person configures. Only the one-line
summaries go to BAB, never transcript text. `--no-llm` sends nothing to any model.

1. Keep history. Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Raise it
   in its settings (for example to 400) now, so there is history to backfill later.
2. Draft, on each machine: `node scripts/cc-backfill.mjs draft --out backfill.json --map map.json`
   from a checkout of this repository. It reads `~/.claude/projects/*/*.jsonl` (timestamps, working
   folder, git branch and the user and assistant text), splits each session into work blocks at
   gaps of more than 30 minutes, and leaves out blocks that ended less than 2 hours ago. It asks
   your own model endpoint for one `worked` line per block: set `BAB_BACKFILL_BASE_URL` (an
   Anthropic Messages compatible endpoint), `BAB_BACKFILL_MODEL`, and `BAB_BACKFILL_API_KEY_ENV`,
   the name of the variable that holds the key. The key is read from that variable only and never
   printed or written. `--no-llm` writes a plain line from the folder name and branch instead.
   Nothing is uploaded in this step.
3. Map. Each block goes to an initiative by the rules in the map file you edit: a working folder
   (substring), a repository folder name, a branch pattern or a ticket-style key such as `KEY-1`
   in the branch or the text. The first rule that matches wins. A block no rule matches goes to
   `unassigned`; nothing is guessed. The draft also writes `backfill.map-template.json` with the
   folders and branches of unmapped blocks and the keys in those branch names (never keys from
   transcript text), so you can add rules and draft again. The draft, the table and the template
   are written for you only (mode 0600, where the file system has modes).
4. Review `backfill.json` and the readable `backfill.md`. Set `include` to false for a line
   you do not want, or edit it. Lines that look like a secret are already set to false with the
   reason in `flagged`.
5. Upload: ask your agent for a backfill link (`bab_command_center` action `backfill_link`), then
   run `node scripts/cc-backfill.mjs upload --draft backfill.json --url "<link>"`, or set the link
   in `BAB_BACKFILL_LINK` and leave out `--url`, which keeps it off the command line and out of
   shell history. `--dry-run` shows what would be sent. The tool refuses redirects on every
   request. Only `id`, `initiative`, `title`, `key`, `worked`, `size`, `at`, `session`
   and `machine` of included lines are sent.

The link:

- is made only for a bound identity whose switch is on, and only the sha256 of its token is
  stored. Entries always land in the log of the person who made it; the upload carries no identity.
- works once, within 15 minutes. It is spent before the body is read, so a refused upload needs a
  new link. At most 20 unused links per person.
- takes at most 2000 entries and 1 MB. The tool sends one batch per link and prints the `--from`
  value to continue with a new link (or pass `--url` more than once).
- is a public path for BAB's API token gate (the token in the path is the credential). A sign-in
  proxy in front of BAB needs `/api/command-center/backfill/` on its own public-path list too. A
  reverse proxy may log the path, so the link is short-lived and single use.

The import:

- Each entry is checked like a `worked` line on publish: one line, at most 200 characters, and
  text that looks like a secret or personal data is refused, naming the field. `at` needs a time
  zone, may be at most 5 minutes in the future and no older than `BAB_COMMAND_CENTER_LOG_DAYS`.
- The server sets `source: "backfill"` and kind `worked`; an entry that sends `source`, `kind` or
  any other field is refused.
- It is idempotent: the stored entry id comes from the entry's own `id` (the tool uses the session
  id and the block start), so uploading the same draft again adds nothing.
- An entry for an initiative you do not have creates a minimal parked record with the entry's
  `title`, within the usual 100 initiative limit. One upload creates at most 20 initiatives.
  Without a title, or over either limit, the entry goes to `unassigned` with the reason in
  `reassigned`. The answer lists accepted, duplicate, refused (with the reason) and created ids.
  A refused entry does not stop the others.
- At most 20000 backfill entries per person. Minting a link is audited (`cc_backfill_link`), and
  so is spending one, with the verified client address, before the body is read
  (`cc_backfill_link_used`), so a spent link whose upload then fails still shows. The import
  itself is audited (`cc_backfill`) with counts only.

Current state (`current`, optional, at most 100 records per upload; a body with only `current`
is valid):

- Each record is `{ id, title, area?, key?, state: "active", tasks?, questions? }`,
  checked exactly like a publish (same id rules, limits and secret checks; ids `backfill`,
  `export` and `unassigned` are reserved; only state `active`). Any field outside that list
  (also `links`), or any invalid record, refuses the whole upload (400).
- Create only: a record whose `id` you already have, or had (it has log entries, or its removal
  is in the audit log), is skipped and counted in `syncSkipped`, so a stale session cannot bring
  back a removed initiative. The live record is never changed. The insert is conditional inside
  the upload's transaction, so a publish racing it is never overwritten.
- A new record is an active project with server times (task `startedAt`/`finishedAt`, question
  `askedAt`, `updatedAt`); client times are not taken. It gets one log entry of kind `synced`
  (source `backfill`) and counts in `syncCreated`. New records share the 20 new initiatives per
  upload with the entries' and the usual 100 initiative and size limits; one over a limit is
  listed in `syncRefused` with the reason. Records are handled before entries, so an entry for a
  synced initiative lands under it. The audit row adds `syncCreated`, `syncSkipped` and
  `syncRefused` counts.

### Sync current sessions

Right after installing the plugin, the page can show what your sessions are doing now, without each
session publishing by hand. On first use, when `list` returns no initiatives, the skill offers this
once. From a checkout of this repository, on each machine:

1. `node scripts/cc-backfill.mjs sync --out sync.json [--days 14] [--max 20] [--map map.json]`. It reads the
   sessions active in the last `--days` days (default 14) from `~/.claude/projects` (or
   `--projects-dir`). Per session it takes the latest state: the last plan (from the plan tool or
   `TodoWrite`: step text and status as last set by those calls), the open question of the last `wrap_up` when it was blocked
   and nothing was answered after it (its ask, with the action labels as options), the session
   title, the repo folder name and the git branch. It writes `sync.json` and a readable `sync.md`
   (mode 0600). It sends nothing and calls no model.
   The desktop app's `wrap_up` checks off the whole plan at the end of every turn, so the tool
   ignores that: a plan reads finished only when the last `wrap_up` recap starts with "Done"
   (as in "Done: ...") and no plan call came after it. A `TodoWrite` list keeps its own statuses.
2. Initiatives: sessions with the same title (compared as a slug) count once (the most recent,
   preferring one with a plan; the others are only counted, before `--map` and grouping). Sessions sharing a Jira-style key, or the same repo and a non-trunk branch, merge into
   one. A `--map` file (the same rules as for `draft`) wins and names the id. Any other id is the
   slug of the title, as an agent makes a publish id (a-z, 0-9, `-`, at most 40), so a later
   publish by that session with the same id is the same initiative. A clash gets `-2`, `-3`.
3. Review `sync.json` and `sync.md`. Every record is listed with `include` true or false, and
   why: only records with a plan are included, at most `--max` (default 20, the most recent);
   the rest say `left out (no plan)` or `left out (over --max 20)`. Task and question text goes
   through the same masking and secret checks as the log draft; a record that was masked or looks
   like a secret is flagged and has `include: false`. The tool does not judge content: set
   `include` to false for anything personal or not work, true for anything you want.
4. Upload with a backfill link as in step 5 above (`upload --draft sync.json`). Only `id`, `title`,
   `area`, `key`, `state`, `tasks` and `questions` of included records are sent. The server only
   creates: an initiative that already exists on your page is skipped and counted, never changed.

Limits: a session without a plan is left out unless you include it (then it gives a title only);
the state is as of each session's last turn; the tool runs per machine; at most 100 records and 20
new initiatives per upload (so a `--max` over 20 needs a second link for the rest).

## Export

- The person downloads their own log on the page (`GET /command-center/export`, the signed-in
  viewer only, audited `cc_export_own`).
- `BAB_COMMAND_CENTER_EXPORT_APPS` lists report apps as `app=token`; the token carries the export
  scope and nothing else. An app reads `GET /api/command-center/export` with that token as a
  bearer, only for people who granted that app on their own page and whose switch is on. The
  person grants or revokes each app on the page (same-origin viewer posts, audited
  `cc_export_grant` and `cc_export_revoke`). Every app read is audited (`cc_export_app`).
- Aggregated by default: counts per initiative and UTC day (`entries`: all log entries; `worked`:
  worked lines only, not imported notes; `backfilled`: entries from a backfill upload; sizes) with
  the initiative's title and key, but no log lines and no session. `detail=entries` returns the
  entries only for people who granted the `entries` level. Every entry, in that export and in the
  person's own download, carries its `source` (`live`, `import` or `backfill`); the page tags
  backfilled lines in each initiative's log. `from` and `to` are dates, at most 400 days apart; the default is the last 92
  days.
- `/api/command-center/export` is a public path for BAB's own API token gate, because the app token
  is the credential. A sign-in proxy in front of BAB has its own public-path list: add the path
  there too, or apps cannot reach it.
- Rate limits: before the token is checked, each client address gets `ANON_RATE_LIMIT_PER_MINUTE`
  (lib/rate-limit.ts) in a bucket of its own, counted only when `BAB_CLIENT_IP_HEADER` is set; then
  each app gets the Command Center token bucket. Over a limit the answer is 429 with `Retry-After: 60`.
- `detail=entries` also shares the session and machine name on each entry; the page says so.

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
`command_center_log` the log, `command_center_export_grants` the person's consent per app, and
`command_center_backfill_links` (migration 55) the sha256 of each backfill link's token. Every
query is keyed by the owner. Each write runs in one transaction from its first read to its last
write, so there is no lease, no snapshot and no need to republish after a restart.

Moving from v2: at start, an existing `DATA_DIR/command-center-snapshot.json` is imported.
Every record is checked as strictly as a new publish, broken ones are dropped and counted in the
log, a record already in SQLite is never overwritten, and v2 comments become `note` log entries at
their own time. The file is never renamed or rewritten. Its sha256 is recorded, so a later start
skips it quietly and it is never imported twice.

Rolling back to v2.19: v2.19 ignores the v54 database and reads the untouched snapshot, so it shows
the state at the v3 release. Everything written in v3 stays in SQLite and is back when v3 returns.
If v2.19 rewrote the snapshot, the next v3 start imports it again: changes made on v2.19 to an
initiative that also exists in SQLite are not imported (agents republish); new initiatives are.

30 days after an import the snapshot is deleted, but only while its sha256 is still the imported
one, so a file rewritten by a rolled-back v2.19 is never deleted before v3 has imported it. A
rollback after that starts empty. A `command-center-snapshot.imported.json` left by an earlier v3
build is deleted after the same 30 days.

The opt-in switch is two columns on `users`.

Retention, one rule each: the page shows active initiatives that are not silent; done, parked and
silent ones stay in `list` and in the log. A live record goes 30 days after its last write. The log
is kept `BAB_COMMAND_CENTER_LOG_DAYS` days (default 400). People switched off for 30 days lose
records, log and grants. Cleared questions stay 7 days. Writes are audited (`cc_publish`,
`cc_clear`, `cc_remove`, `cc_enable`, `cc_disable`, `cc_delete_all`, and the export rows above)
with the person, the initiative id and the result, never the text.

## The page

`app/command-center/page.tsx` renders for the signed-in viewer only, at the app's standard content
width like every other page. The header is one line: title, the On pill, the last push and
the data-health chips, which turn amber or red when not 0. Switch off and Delete sit in a
settings menu; Delete asks for a confirm first.

- Needs you: short question cards, oldest first, about three per row on a desktop screen: the
  question, one meta line with the initiative, a possibly-stale tag and the age, then the options
  as small pills (display only) beside Dismiss. A left bar marks urgent and high priority. With
  none, an All clear card.
- Initiatives: a row of status counts (All, Needs you, Active, Idle, Finished); pressing one shows
  only that status, pressing it again shows all. Then one masonry flow of compact cards (CSS
  columns: three at 1024 px and up, two at 700, one on phones), with no area headings.
- Each card has one status badge, derived on the server (`ccStatusOf`): Needs you (an open
  question), Finished (state done, or every task done), Active (a publish under 2 hours ago),
  else Idle. Paused and parked cards are Idle with a small paused mark. Cards sort Needs you,
  Active, Idle, Finished, then urgent, high, none, low, paused, then most recently updated. The
  status is part of the poll stamp, so a card that passes the 2 hour line updates on its own.
- Collapsed, a card shows only the title, the badge, a progress bar with the percent and done/total,
  the main task (the one in progress, else the next pending) in larger type, and up to 5 other
  tasks with status icons, open work first, then "+N more". A finished card shows no task list.
- A click on the card, or its Details toggle (a `<details>`, keyboard accessible), opens the rest in
  place: state, priority, key and deadline tags (near and overdue in words, days counted on UTC
  dates), the open questions, the full task list when it was cut, links as pills with their host,
  the small Log of the latest entries, when it was updated and who pushed last. Clicks on links,
  buttons and the opened part do not toggle it. An opened card grows without stretching its
  neighbours. Paused cards have grey chrome; their text keeps full contrast.
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
