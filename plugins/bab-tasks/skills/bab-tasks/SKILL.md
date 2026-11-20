---
name: bab-tasks
description: "ALWAYS use, unasked, in every session and on every turn. The person's private BAB Tasks (<bab_url>/tasks) shows all their work. Publish to it with bab_tasks at the start of every session, whenever work starts, changes or finishes, and as the last call of every turn. Every to-do, next step, follow-up or question you mention MUST be on it in the same turn, never only in your reply, and every publish carries the link to this session. Skip it only when the person says so."
---

# BAB Tasks

`<bab_url>` is your BAB server's address, the BAB plugin's `bab_url` setting. This skill needs the BAB
plugin for the `bab_tasks` tool. The same text is served at `<bab_url>/instructions/tasks.md`.

BAB Tasks is a private page, <bab_url>/tasks, where the person sees what their own
agent sessions are doing: initiatives with progress, open questions with their age, the health of
recurring upkeep, links, and a short log of what was worked on. You publish; the page only shows.
Nobody else sees it.

## The rule

**Every to-do goes on BAB Tasks, always, unasked.** Every step you tell the person is still to
do (next steps, to-dos, follow-ups, anything waiting on their go-ahead) MUST be a task in the same
turn's publish, and every question you ask them MUST be in `questions`. If your reply lists remaining
work that is not in the record, the turn is not finished: publish it first. Never publish `tasks: []`
for a project with work left: it erases its progress. The person must never have to ask for this.

**Links people can open go in `links`**: the PR, the ticket, the doc, or a session link when your
tool has an https one. `source.link` is deprecated: the page ignores it, so leave it out.

The last call of every turn is `publish` with `worked`, even when the turn only answered a question
or declined a task. In Claude Code the bab-tasks plugin's Stop hook checks this: a turn that made
tool calls but no `bab_tasks` publish or patch, or 5 or more calls after the last one, is sent back once.

If this skill is loaded, call `bab_tasks` `publish` with the whole initiative record (same `id` every time, `v: 1`) before the first work step
of your first turn, with that step `in_progress`. Publish again (or `patch`, see The record) after
every task status change, and publish as the last call of every turn, after the work has returned.
`worked` is one line on what this turn did, such as "Wrote the exporter" or "Answered how many
fields were mapped". When you stop to ask the person something, put the same question in
`questions` with a stable id; the turn the answer arrives, publish without it, which clears it.
Never put secrets, client names or customer data in any field. Never publish for anyone else.

Your first reply after your first publish includes the full page link <bab_url>/tasks.
Always paste the URL itself, never only say that BAB Tasks is tracking the work. Later replies do
not repeat it.

To see what another session published, call `list` with the `id`: it returns the full record and
its `seq`. Merge, then `publish` with that `expectSeq`. A 409 answer carries the current record
after `current:`: merge it and send the call again with the `expectSeq` it names. Never skip
publishing for fear of overwriting; `expectSeq` protects the other session. To change only a few
items, or to leave another session's changes alone, you may use `patch` instead (see The record).

There is no switch: installing the bab-tasks plugin turns it on, and your first `publish`
creates the person's page. If they ask you to leave it alone, or the tool answers that BAB Tasks
is off on this BAB, stop calling it for the rest of the session and say nothing more about it.

## Scheduled and unattended runs

A scheduled or unattended run (a nightly job, no person in the session) that owns a recurring card
keeps that card fresh:

- The run's prompt names the card `id`. If it does not, call `list` and use the `recurring`
  initiative that matches the job. Never create a new initiative per run; publish a new recurring
  record only when `list` has none for the job.
- Every run ends with `patch` on that card, with `health` (`level`, `reason`, `checkedAt` now) and
  `worked`. This goes for a clean run with nothing to do (`green`) and for a failed or blocked run
  (`red` or `amber`, with the reason). A run that writes nothing leaves the card overdue. This
  `patch` stands in for the closing `publish`.
- When you create a scheduled task that owns a recurring card, put the card `id` and this last
  step in its prompt.

For example
`{ "action": "patch", "id": "nightly-upkeep", "record": { "health": { "level": "green", "reason": "Nothing to do", "checkedAt": "2026-01-01T02:00:00Z" }, "worked": "Nightly upkeep: nothing to do" } }`.

## The person's data

Only when the person asks, and only for their own data (the page has no settings):

- `delete_all` erases their records, log and report-app grants. It cannot be undone. Run it only when the person asks, with `"record": { "confirm": true }`.
- `export` returns their log and the report apps, with what each may read, as JSON.
- `grant_export` with `id` the app and `record: { "level": "aggregate" }` (or `"entries"`) lets a
  report app read their log; `revoke_export` with `id` withdraws it.

## The record

`publish` takes the whole record. Leave out a field and it is gone; send what is true now. One
exception: leaving out `health` keeps it (send `null` to clear it). Publishing the same record
again changes nothing (`unchanged: true`), but a new `worked` line is still logged.

Send the record as one object in `record`, with `action` and `id` beside it:
`{ "action": "publish", "id": "billing-export", "record": { "v": 1, "title": "Billing export", "tasks": [], "worked": "Planned the export" } }`.
Put `action`, `id` and `record` at the top level of the call. Never nest them inside `record`.

`patch` is optional. Publish stays the default; use `patch` to change a few items of an initiative
that already exists (an unknown `id` is refused: publish it first), or when another session also
writes it, so neither overwrites the other. Send only what changed: a field you leave out keeps its
value, and `null` clears an optional one (never `title`, `state` or `kind`). In `tasks`,
`questions` and `links`, each item is a change, found by its `id` (links by `url`): a known one is
updated with the fields you send, a new one is added, and `"remove": true` drops it (a removed
question is cleared). Items you do not name stay as they are. `source` merges field by field; send
it with every patch, as on publish. The same limits and checks apply to the merged record. For example
`{ "action": "patch", "id": "billing-export", "record": { "tasks": [{ "id": "build", "status": "done" }, { "id": "ship", "text": "Ship it", "status": "pending" }], "source": { "session": "<session id>" } } }`.

| Field | Rules |
| --- | --- |
| `v` | `1`. Required. |
| `id` | Slug: a-z, 0-9 and `-`, at most 40. Stable: a new id is a new initiative. |
| `title` | 1 to 120 characters. |
| `area` | Optional, at most 40. The page groups by it. |
| `key` | Optional ticket key, such as `KEY-1`. |
| `state` | `active` (default), `done` or `parked`. |
| `kind` | `project` (default) or `recurring`. |
| `cadence` | Recurring only: `daily`, `weekly` or `drain`. |
| `deadline` | `YYYY-MM-DD` or null. |
| `priority` | `urgent`, `high`, `low`, `paused` or null. Paused hides its questions. |
| `tasks` | At most 50 `{ id, text (120), status }`, status `pending`, `in_progress` or `done`. None for recurring. |
| `questions` | At most 5 open `{ id, text (500), options }`, at most 4 options of 60. An id you leave out is cleared. |
| `health` | Recurring only: `{ level, reason (200), checkedAt }`, level `green`, `amber`, `red` or `unknown`, checkedAt an ISO time. Send it after every run, clean or failing. |
| `links` | At most 20 `{ label (60), url }`. `https://` only. |
| `source` | Optional `{ machine (20), session (60) }`; they show as "last pushed by". A `link` is still accepted but ignored. |
| `worked` | One line, at most 200: what this turn did. Logged with the server's time, not stored in the record. |
| `size` | Optional with `worked`: `small`, `medium` or `large`. No time estimates. |
| `expectSeq` | Optional, on publish and patch. The `seq` you last saw; a mismatch is 409 with the current record to merge. Every answer gives the new `seq`. |

At most 1000 initiatives and 20 MB per person, 32 KB per record. Unknown fields, bad values and
text that is too long are refused with a sentence that names the field and the fix. Nothing is cut
short. The server sets every time itself, so send none except `health.checkedAt`.

## The other actions

- `list`: your initiatives with `seq`, open questions and a data-health summary. With `id`: that
  initiative's full record, with its `seq`.
- `remove` with `id`: when an initiative should not be shown any more. Its log stays.
- `backfill_link`: only when the person asks to backfill their log from old sessions. It returns
  a link for one upload within 15 minutes. Give it to the person for the backfill tool's upload
  step; never upload yourself and never read their transcripts.

## First use: sync current sessions

On first use, if `list` returns no initiatives, offer the person once (never again in the same
session, and not if they decline) to sync their active sessions to the page: the BAB Tasks
sync tool reads their recent local sessions, writes a draft of current initiatives with tasks and
open questions, and uploads it only after they have read the draft and said yes. When they accept,
call `backfill_link` for the upload link and hand it over; never upload yourself and never read
their transcripts. The sync only creates initiatives that are not on the page yet; it never changes
one you published. It includes only sessions with a plan (at most 20, the person can change any
`include`), shows each session as of its last turn, and has to run once per machine.

The command, from a checkout of the BAB repository: `node <repo>/scripts/cc-backfill.mjs sync --out sync.json`, then `node <repo>/scripts/cc-backfill.mjs upload --draft sync.json --url "<link>"` after review (details in docs/bab-tasks.md).

## Keeping it true

- The server logs your `worked` lines and what it sees itself: tasks started and done, questions
  asked and cleared, health and state changes. A retried publish logs nothing twice.
- A question the answer lists in `dismissed` stays cleared while you send the same id and text:
  stop asking it. Reword it only if it is a new ask.
- A question older than 3 days, on a done or parked initiative, or kept by another session is
  shown as possibly stale. Leave answered ones out of the next publish.
- The page shows active initiatives. Done, parked and silent ones (no publish for 14 days) leave
  the page but stay in `list` and in the log. A record goes 30 days after its last publish, a
  parked or paused one after 180 days. `list` gives each record's `expiresInDays`.
- Recurring upkeep is overdue when its health is older than 26 hours (daily), 8 days (weekly) or
  2 hours (drain).
