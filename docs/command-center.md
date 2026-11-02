# Command Center

Command Center is a private page, `/command-center`, where a person sees what their own agent
sessions are doing: initiatives with progress, open questions with their age, the health of
recurring upkeep, and links. Agents push the state; the page only shows it. Nothing in it is a
source of truth: an agent can always publish the whole record again.

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
- Turning it off keeps the records 30 days (switch on again to restore them), then deletes them.
  "Delete all my records now" deletes them at once.
- `BAB_COMMAND_CENTER=false` switches the feature off for the whole deployment.

## API

One lib (`lib/command-center.ts`) behind one MCP tool and the REST routes.

| MCP `bab_command_center` action | REST |
| --- | --- |
| `publish` (the whole record, optional `expectSeq`) | `PUT /api/command-center/<id>` |
| `list` | `GET /api/command-center` |
| none | `GET /api/command-center/<id>` |
| `clear_question` (`id`, `questionId`) | `POST /api/command-center/<id>/actions` |
| `comment` (`id`, `text`) | same |
| `health` (`id`, `level`, `reason`, `checkedAt`) | same |
| `remove` (`id`) | same |

`POST .../actions` takes an `Idempotency-Key`. A `PUT` is idempotent by nature.

The MCP tool declares only `action`, `id` and `record`. Agents send the record, or the fields of
`comment` and `health`, as one object in `record`. `action` and `id` go beside `record`, not inside it; the ones inside are
ignored, and a publish without a top-level `id` is a 400. A `record`
that is not an object is a 400. Some clients send undeclared fields as strings, so on the MCP path
only a numeric string `v` or `expectSeq` and JSON text for `tasks`, `questions`, `options`, `links`,
`comments`, `health` and `source` are read (`null` clears `health` and `comments`); text that does not
parse is a 400 naming the field. REST stays strict and refuses a `record` field.

Only a bound identity is served: the BAB plugin's device, the sign-in proxy, or an API token bound
to the person. An identity sent only in headers is refused. The owner of every record is the
resolved identity, never a body field. Nobody can read another person's records.

## The record

The record format, with every limit, is in the skill: `content/instructions/command-center.md`.
In short:

- `v: 1` is required. Unknown fields are refused with the allowed list. Too long is 400; nothing is
  cut short. Text that looks like a secret or personal data is refused and the field is named.
- At most 100 initiatives and 256 KB per person, 32 KB per record (413), 256 KB per request.
- The server owns every time except `health.checkedAt`: `updatedAt`, `seq`, a question's
  `askedAt` and `clearedAt`, a task's `startedAt` and `finishedAt`, a comment's `at`, health
  `receivedAt`. Clock skew between machines never shows.
- `expectSeq` that does not match is 409 with the current record, unless the record you send is
  already exactly the current one (a retried request): that is `unchanged: true`, not a 409.
- A 409 answer includes the current record: merge it and publish again. REST returns it as
  `current`; the MCP tool, which has no get, puts it in the error text after `current: `.
- Publishing the same record again changes nothing (`unchanged: true`): no new `seq`, time or audit row.
- Leaving out `comments` or `health` keeps them, since they have their own actions; `[]` or `null` clears them.
- A question the person dismissed on the page stays cleared while the agent sends the same id and text; the answer lists it in `dismissed`. A dismissal moves neither `seq` nor `updatedAt`.
- Cleared questions are kept 7 days, at most 20 per initiative.
- 60 calls a minute and 20 at once per person, on top of the general limit.

## Derived flags

- A question is possibly stale when it is older than 3 days, its initiative is done or parked, or a
  later publish from another `source.session` kept it.
- An active initiative with no write for 14 days is silent.
- Recurring upkeep is overdue when its health is older than 26 hours (daily, the default), 8 days
  (weekly) or 2 hours (drain). Unknown is never overdue.
- `priority: paused` hides the initiative's questions and counts nothing as stale or silent.
- The list answer and the page header carry a data-health summary: stale questions, silent
  initiatives, upkeep without health, overdue upkeep.

## Storage

In memory, one map per person, written to `DATA_DIR/command-center-snapshot.json` every 30
seconds when something changed and on SIGTERM (temp file, fsync, rename). Only the process that
holds the key-value lease (`DATA_DIR/kv.lease`) serves it; a second process answers 503. Every
entry is checked again at start; broken ones are dropped and counted in the log, and a broken file
means an empty store. A crash loses at most 30 seconds; agents republish.
"Delete now" and `remove` are written to disk at once. A process that once lost the lease never
serves or saves its map again, even if it takes the lease back later.

The opt-in switch is two columns on `users` in SQLite, so a crash never forgets it.

Retention: done and parked initiatives go 30 days after their last write, active ones after 60.
Cleared questions stay 7 days. Writes are audited (`cc_publish`, `cc_clear`, `cc_comment`,
`cc_health`, `cc_remove`, `cc_enable`, `cc_disable`, `cc_delete_all`) with the person, the
initiative id and the result, never the text.

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
  1024, one on phones), grouped by area with the area name as a small heading inside the flow, ordered urgent, high, none, low, paused. Small areas share
  columns, and an opened card grows in place without stretching its neighbours. Each card has
  state, priority, key and deadline tags (near and overdue in words, days counted on UTC dates),
  a progress ring with the percent inside beside the title, the task in progress on one line,
  and one meta line with a done/total toggle that opens the task list and notes, links as pills
  with their host, and who pushed last. Silent and paused cards have grey chrome and
  a label; their text keeps full contrast.
- Recurring upkeep: one line each with a health dot and label, the reason (cut short, full text in
  its tooltip; wrapped on phones), when it was checked and an overdue tag.

Every agent string is React text, never HTML; a link shows its host, and its full URL is its title. Colours are tokens on
the page, with dark values for `data-theme="dark"`, like /usage. Motion honours
`prefers-reduced-motion`.

The open page polls `/command-center/state` every 15 seconds while the tab is visible and
refreshes when the stamp changed. It does not use `/api/events`, which is public.
