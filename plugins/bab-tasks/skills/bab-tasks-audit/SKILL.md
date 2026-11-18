---
name: bab-tasks-audit
description: "Use for a periodic or on-demand audit of the person's BAB Tasks (<bab_url>/tasks): check every card against its evidence (PR, ticket, file, doc), mark finished work done, flag stale questions, silent cards and cards whose session is gone. Run it nightly as a scheduled task or when the person says their BAB Tasks is out of date."
---

# BAB Tasks audit

This skill needs the BAB plugin for the `bab_tasks` tool and the bab-tasks skill for the record
format (<bab_url>/instructions/tasks.md). The same text is served at
`<bab_url>/instructions/tasks-audit.md`.

The audit syncs the person's private BAB Tasks (<bab_url>/tasks) with reality. Cards drift: a PR
merges, a ticket closes, a session ends, and the card still says pending. You check each card against
its evidence and correct the status. You change status only. The person decides everything else.

## Rules

- Edit audited cards with `patch`, never `publish`: another session may write the same card. Send `expectSeq` from `list`. On a 409, merge from `current` and retry once with its `seq`, then skip the card.
- Send no `source` on an audited card. This overrides the bab-tasks rule: `source` would make you the card's owner and hide the real owner's questions behind "possibly stale".
- Allowed on an audited card: set a task `done` or `in_progress`, add a question, add a task with an `audit-` id. Set `health` only on the audit's own recurring card.
- Never `remove` a task, question, initiative or link. Never set `state` to `done` or `parked` for a whole initiative. When one looks finished or abandoned, add a question with options (`Mark done`, `Keep`) and leave `state` alone.
- Never message anyone, comment on a PR or ticket, merge, approve or deploy. Read only outside BAB Tasks.
- Evidence you cannot check (no access, tool missing, a login needed) stays as it is. Never guess done. Count it as unverified.
- No secrets, client names or customer data in any field.
- Cover every card from step 1 (not `done`, not paused). "Unchecked" is never "could not verify": a card you did not look at is unchecked, and only a card you tried and failed to check for a named reason is "could not verify".
- Time budget: 30 minutes. No progress for 10 minutes means stop and report.
- On-demand run: your own session's closing `publish` on its own card is fine. Scheduled run: the closing `patch` on the audit card stands in for it.

## Stable ids

The audit runs every night. Every item it adds uses a fixed id, so a rerun never adds it twice:

- `audit-owner-gone` (task), `audit-still-active` (question), `audit-quiet-<taskid>` (task), `audit-confirm-<questionid>` (task), `audit-closed-pr-<taskid>` (question).
- Before adding, check the record: skip an id already present, and skip a question whose id is in `dismissed` with the same text.
- A card with 5 open questions gets no new question. Count it as a flag in your summary.
- Task text is at most 120 characters. Cut it.
- Patch a card only when something really changed. Any patch counts as activity, so a needless patch keeps a dead card alive.

## Steps

1. `bab_tasks` `list`. Take every `active` initiative and every `parked` one. Skip `done`, and skip `priority: paused` cards. Note each card's `silent`, `overdue` and `expiresInDays`.
2. Write the checklist first: one line per card id from step 1, in order, in a scratch file or your reply, before you check anything. Work through it and mark each line `checked` or `could not verify: <reason>`. The run may close only when no line is left blank. Do not stop at a few cards because the first ones took long.
   If the task prompt names an evidence file (card ids, links, PR states), read it and use it instead of fetching the same state again. Fetch only what it lacks.
3. For each card, `list` with its `id` for the full record and `seq`.
4. Check each task that is not `done` against its evidence. Use the card's `links` and the task text, with whatever the person has: a forge CLI or MCP for PR state, an issue tracker for ticket state, the file system for a file, a fetch for a doc. Rules of thumb:
   - A linked PR is merged: the task that PR delivers is `done`.
   - A PR is closed unmerged: do not mark done. Add question `audit-closed-pr-<taskid>`: "PR closed without merge, drop this task?"
   - A ticket is closed or done: mark the task it covers `done` only when the task names that ticket. Otherwise leave it.
   - A file or doc the task says to write exists and has content: `done`. An empty or missing one stays.
   - A task is `in_progress` but its PR or branch has been quiet for 7 days: add task `audit-quiet-<taskid>`: "Quiet for 7 days: still going?". Keep the status.
5. Flag, never clear:
   - A question older than 3 days (the page marks it possibly stale): if evidence answers it (a merged PR, a closed ticket), add task `audit-confirm-<questionid>` with a short text, such as "Confirm: PR merged, close the question?". Keep the question until the person answers.
   - A card on `active` with no publish for 7 or more days, before the page hides it at 14: add question `audit-still-active`: "Still active?" with options `Yes`, `Park it`. Skip `parked` cards.
   - A card whose owner session is gone: only when your tools can list sessions and the card's `source` session is not in the list. A card with no `source`, or a session list you cannot read, is skipped. Add task `audit-owner-gone`: "Owner session gone, adopt or park".
   - A recurring card: `list` reports `overdue`. When it is true, add question `audit-overdue`: "Overdue: check the job that owns this card". A recurring card takes no tasks, so a question is the only flag. Never write its `health` yourself.
6. Patch one card at a time with its changed tasks, new questions and a `worked` line of at most 200 characters, such as "Audit: 2 tasks done by merged PRs, 1 flag". Put the evidence for each closed task in that line (PR title or number, checked date), shortened to fit. Skip a card with no change.
7. Count what you did: cards checked of the step 1 total (a `could not verify` card counts as checked), tasks closed, flags added, and the ids of cards that are unchecked or could not be verified, each with its reason. The report always lists them.

## Scheduled run

Run it as a scheduled task with a fresh session, daily. The task owns one recurring card (`kind` `recurring`, `cadence` `daily`) and the run ends, clean or blocked, with `patch` on that card:

`{ "action": "patch", "id": "<audit card id>", "record": { "health": { "level": "green", "reason": "Checked 12 cards, closed 2 tasks, 1 flag", "checkedAt": "<now ISO>" }, "worked": "Audit: checked 12 cards, closed 2 tasks, 1 flag" } }`

Health: `green` when every card is checked. `amber` when every card is checked but some evidence could not be verified. `red` when cards are left unchecked, the audit failed or it ran out of time. The reason names the count, such as "Checked 12 of 12 cards" or "Checked 9 of 12, 3 left". Create the card with `publish` the first time only, when `list` shows none. Tell the person only when a card needs them (a question was added, an owner is gone). A clean run sends nothing.
