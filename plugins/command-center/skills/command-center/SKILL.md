---
name: command-center
description: "Publish and keep current the person's private BAB Command Center page (<bab_url>/command-center) with the bab_command_center tool, and log what each turn did. Invoke it at the start of every session, whenever you create, change or finish an initiative, task or plan step, when you ask the person a question and when their answer arrives, after a recurring check, and at the end of every turn, also a turn that only answered a question or declined a task. The installed plugin means the person wants it; skip it only when they ask you to."
---

# Command Center

`<bab_url>` is your BAB server's address, the BAB plugin's `bab_url` setting. This skill needs the BAB
plugin for the `bab_command_center` tool. The same text is served at `<bab_url>/instructions/command-center.md`.

Command Center is a private page, <bab_url>/command-center, where the person sees what their own
agent sessions are doing: initiatives with progress, open questions with their age, the health of
recurring upkeep, links, and a short log of what was worked on. You publish; the page only shows.
Nobody else sees it.

## The rule

The last call of every turn is `publish` with `worked`, even when the turn only answered a question
or declined a task.

If this skill is loaded, call `bab_command_center` `publish` with the whole initiative record (same `id` every time, `v: 1`) before the first work step
of your first turn, with that step `in_progress`. Publish again after every task status change, and
as the last call of every turn, after the work has returned.
`worked` is one line on what this turn did, such as "Wrote the exporter" or "Answered how many
fields were mapped". When you stop to ask the person something, put the same question in
`questions` with a stable id; the turn the answer arrives, publish without it, which clears it.
Never put secrets, client names or customer data in any field. Never publish for anyone else.

Your first reply after your first publish includes the full page link <bab_url>/command-center.
Always paste the URL itself, never only say that Command Center is tracking the work. Later replies do
not repeat it.

To see what another session published, call `list` with the `id`: it returns the full record and
its `seq`. Merge, then `publish` with that `expectSeq`. A 409 answer carries the current record
after `current:`: merge it and publish again. Never skip publishing for fear of overwriting;
`expectSeq` protects the other session.

There is no switch: installing the command-center plugin turns it on, and your first `publish`
creates the person's page. If they ask you to leave it alone, or the tool answers that Command Center
is off on this BAB, stop calling it for the rest of the session and say nothing more about it.

## The person's data

Only when the person asks, and only for their own data (the page has no settings):

- `delete_all` erases their records, log and report-app grants. It cannot be undone.
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
| `health` | Recurring only: `{ level, reason (200), checkedAt }`, level `green`, `amber`, `red` or `unknown`, checkedAt an ISO time. Send it after each run. |
| `links` | At most 20 `{ label (60), url }`. `https://` only. |
| `source` | Optional `{ machine (20), session (60), link (300) }`; machine and session show as "last pushed by". |
| `worked` | One line, at most 200: what this turn did. Logged with the server's time, not stored in the record. |
| `size` | Optional with `worked`: `small`, `medium` or `large`. No time estimates. |
| `expectSeq` | Optional. The `seq` you last saw; a mismatch is 409 with the current record to merge. |

Put the link that opens this session in `source.link` when you know it (for example claude://claude.ai/epitaxy/<your session id>); the page shows an Open in Claude button.

At most 100 initiatives and 256 KB per person, 32 KB per record. Unknown fields, bad values and
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
session, and not if they decline) to sync their active sessions to the page: the Command Center
sync tool reads their recent local sessions, writes a draft of current initiatives with tasks and
open questions, and uploads it only after they have read the draft and said yes. When they accept,
call `backfill_link` for the upload link and hand it over; never upload yourself and never read
their transcripts. The sync only creates initiatives that are not on the page yet; it never changes
one you published. It includes only sessions with a plan (at most 20, the person can change any
`include`), shows each session as of its last turn, and has to run once per machine.

The command, from a checkout of the BAB repository: `node <repo>/scripts/cc-backfill.mjs sync --out sync.json`, then `node <repo>/scripts/cc-backfill.mjs upload --draft sync.json --url "<link>"` after review (details in docs/command-center.md).

## Keeping it true

- The server logs your `worked` lines and what it sees itself: tasks started and done, questions
  asked and cleared, health and state changes. A retried publish logs nothing twice.
- A question the answer lists in `dismissed` stays cleared while you send the same id and text:
  stop asking it. Reword it only if it is a new ask.
- A question older than 3 days, on a done or parked initiative, or kept by another session is
  shown as possibly stale. Leave answered ones out of the next publish.
- The page shows active initiatives. Done, parked and silent ones (no publish for 14 days) leave
  the page but stay in `list` and in the log. A record goes 30 days after its last publish.
- Recurring upkeep is overdue when its health is older than 26 hours (daily), 8 days (weekly) or
  2 hours (drain).
