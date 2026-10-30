---
name: command-center
description: Keeps the person's private BAB Command Center page (<bab_url>/command-center) true with the bab_command_center tool. Use it in every session once the person has switched Command Center on: publish each initiative you work on, its tasks and the questions you ask them, and clear a question the turn its answer arrives.
---

# Command Center

`<bab_url>` is your BAB server's address, the BAB plugin's `bab_url` setting. This skill needs the BAB
plugin for the `bab_command_center` tool. The same text is served at `<bab_url>/instructions/command-center.md`.

Command Center is a private page, <bab_url>/command-center, where the person sees what their own
agent sessions are doing: initiatives with progress, open questions with their age, the health of
recurring upkeep, and links. You publish; the page only shows. Nobody else sees it.

## The rule

Command Center. If this skill is loaded and the person switched Command Center on, keep their
<bab_url>/command-center page true: call `bab_command_center` `publish` with the whole initiative
record (same `id` every time, `v: 1`) on your first turn, after every task status change, and in
your wrap-up at the end of every turn; when you stop to ask the person something, put the same
question in `questions` with a stable id, and the turn their answer arrives, `clear_question` it
before anything else. Never put secrets, client names or customer data in any field. A 403 saying
Command Center is off means: tell the person once, in one line, how to enable it, then stop
publishing this session. Never enable it, never publish for anyone else.

Give the person the page link once, the first time you publish.

## The record

`publish` takes the whole record. Leave out a field and it is gone; send what is true now.

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
| `health` | Recurring only: `{ level, reason (200), checkedAt }`, level `green`, `amber`, `red` or `unknown`, checkedAt an ISO time. |
| `comments` | At most 20 `{ id, text (500) }`. A publish replaces them. |
| `links` | At most 20 `{ label (60), url }`. `https://` only. |
| `source` | Optional `{ machine (20), session (60) }`, shown as "last pushed by". |
| `expectSeq` | Optional. The `seq` you last saw; a mismatch is 409 with the current record to merge. |

At most 100 initiatives and 256 KB per person, 32 KB per record. Unknown fields, bad values and
text that is too long are refused with a sentence that names the field and the fix. Nothing is cut
short. The server sets every time itself, so send none except `health.checkedAt`.

## The other actions

- `clear_question` with `id` and `questionId`: the turn the answer arrives.
- `comment` with `id` and `text`: adds one note, keeps the last 20.
- `health` with `id`, `level`, `reason` and `checkedAt`: for recurring upkeep, after each run.
- `list`: your initiatives with `seq`, open questions and a data-health summary.
- `remove` with `id`: when an initiative should not be shown any more.

## Keeping it true

- Publish again after a restart: the record is whole state, so a replay changes nothing.
- A question older than 3 days, on a done or parked initiative, or kept by another session is
  shown as possibly stale. Clear what is answered.
- An active initiative with no publish for 14 days is shown as silent and goes after 60 days. Done
  and parked ones go 30 days after their last publish.
- Recurring upkeep is overdue when its health is older than 26 hours (daily), 8 days (weekly) or
  2 hours (drain).
