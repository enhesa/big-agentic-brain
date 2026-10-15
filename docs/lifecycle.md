# How a memory lives

Memories do not expire by default. An agent reading a memory keeps it alive, and one that no agent reads for a
year is archived. Archiving is reversible. Full rules: `docs/spec.md`, "Memories do not expire; unread ones are
archived" and "Restore".

| State | Meaning | In | Out |
|---|---|---|---|
| `active` | Found by search, listed, counted | `bab_learn`, or a restore | Any archive path below, or the author's delete |
| `archived` | Hidden from default search and lists, still fetchable by id; its page says why | Valid-until date over, 365 days unread, voted not helpful and 90 days unread, two flags, retire, or replaced by a correction | `bab_react` `keep` (a restore) |
| `deleted` | Title, body and tags wiped; a tombstone | The author's `delete` | Purged for good after 30 days, with its votes |

**Ways into `archived`**

- **Valid-until date.** `expiresAt` (`YYYY-MM-DD`) is optional: the author's own date for a time-bound fact, such as a
  campaign or a code freeze. It is the last day the memory is valid (UTC): the hourly sweep archives it the day after,
  with an `auto-archive` audit row (reason `valid-until`). `"never"` still means no date. A `keep` does not move the
  date: the author posts a correction with a new `expiresAt`. Until the sweep runs, a memory past its date shows an
  `expired` badge.
- **Unread for 365 days.** The hourly sweep archives an active `learning` or `practice` that no agent has read for
  365 days (audit row `auto-archive`, reason `inactive`). The clock is the last agent read, else the day the memory
  was saved. `standard`, `decision` and pinned house rules are exempt. Reads were not recorded before 2026-10-07
  (migration v40), so no clock starts earlier: nothing is archived this way before 2027-10-07.
- **Voted not helpful and unread for 90 days.** An active `learning` or `practice`, not pinned, that 3 or more
  distinct people marked `not_helpful` (only votes after the latest keep, restore or confirm count), outnumbering its
  `helpful`, `confirm` and `kudos`, is archived by the same hourly sweep once no agent has read it for 90 days (audit
  row `downvote_archived`). The clock is the same as above and never starts before 2026-10-07. The author's session is
  told first that it will be archived if nobody reads or keeps it; any agent may `keep` it with a note. Standards,
  decisions and pinned house rules are never archived this way: they wait for a maintainer (`bab_search`
  `flagged: true`).
- **Two flags, a retire, or a correction that replaces it.** See the spec, "Trust". Only flags placed
  after the latest restore count.

**What counts as an agent read**

| Counts | Does not count |
|---|---|
| A page of results from `bab_search` or `GET /api/learnings` (a plain list by kind, project or repo too) | A person opening `/memory` or `/memory/[id]` |
| `GET /api/learnings/:id` | The session-start digests (house rules, project titles) and `houseRules: true` |
| `helpful`, `confirm` or `kudos` from someone other than the author (a repeat helpful or confirm counts too) | `not_helpful` and `flag` |
| `keep` from anyone | A search with `flagged: true`, or with a `status` other than active |
| | The candidates a refused `bab_learn` returns, and anything on an archived memory |

A read writes two columns, `last_accessed_at` (the first read of the UTC day) and `access_days` (the days with a
read), at most once per memory per day. `updated_at` is untouched and no live event is sent.

**Restore.** `bab_react` `keep` on an archived memory makes it `active` again. Anyone may do it, and a non-author
gives a one-line note (where it was checked, and when). The restore restarts the 365-day clock, and earlier flags stay
on record. Not restorable: a deleted memory; one a correction replaced (supersede its replacement instead); one
whose valid-until date has passed (post a correction with a new `expiresAt`). Restoring someone else's retired
standard or decision is for its author or a maintainer, by the texts. A `keep` on a live memory counts as a read, and
a maintainer's `keep` answers a flag on a standard or decision.

**What people see.** The memory page shows Helpful, Kudos, Not helpful and Flags (always, also at 0), "Last read
by an agent", "Days read by agents", "Valid until" (when set) and, after a sweep archive, a banner with the reason (while its audit row exists, 180 days). On `/usage`, Upkeep shows
"Quiet 9+ months" (live learnings and practices, not pinned, unread for 270 days, three months before the sweep),
"Archived unread" (last 30 days), Kept, Restored, Retired and Flags waiting. Quiet shows nothing before July 2027,
Archived unread nothing before October 2027. The Clean-up card shows the last 8 weeks of archives (unread, not
helpful, flags), retires, keeps and restores, and confirms on old memories that were due a check.

**Gone since 2026-10-07:** the 180-day default expiry, the `expiring` status, "reset by use" and the two
session-start expiry notices. Migration v40 turned every `expiring` memory into `active` and cleared the dates
authors had not chosen.

