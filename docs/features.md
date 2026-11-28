# Features in detail

The [README](../README.md#features) has the short tour. This page lists every feature.

## Memory

- **Kinds.** A learning is a fact or gotcha. A practice is a should. A standard is a must, posted and changed by maintainers only. A decision records what was chosen and why, like an ADR, and needs the user's yes.
- **Scope.** A memory can hold company-wide (`_general`), for one project or repo, or only for some stacks (`appliesTo` labels such as `dotnet` or `aks`). Results for another stack come last.
- **Standing.** Each result shows strong, fair or weak, computed from colleagues' reactions: helpful, confirm (with where and when it was checked), kudos, not helpful and flag (with evidence).
- **Lifecycle.** Two distinct flags archive a learning or practice. A correction supersedes the old memory and links to it. A valid-until date archives it the day after. A memory over 90 days old without a recent confirm by someone other than its author is marked `verify`. Every memory carries a trust label and a validation history: who confirmed, flagged, kept or replaced it, when and why. One that no agent reads for a year is archived. Standards, decisions and pinned house rules are exempt from that. Details: [lifecycle.md](lifecycle.md).
- **On the web.** Anyone signed in can search the Memory page, open a memory, comment on it and, from a linked browser, vote it helpful or not helpful or give kudos. Authors hear about a comment in their next session.
- **Search.** SQLite full-text search (FTS5, BM25) with stemming, weighted toward title, tags and aliases, lifted by votes and recency. Several phrasings are merged by reciprocal rank fusion. Each result says how many query terms it holds (`matchedTerms`), and an answer where none holds half is marked `weak`. No vector database.
- **House rules.** Maintainers pin standards and practices. Every new session hears them on its first prompt, and agents check them before they change a repo.

## Working together

- **Messages.** `bab_send` writes into a person's inbox, never into one session. Their agent hears "1 unread" at the next prompt. Your own address makes it a note to yourself that any of your sessions sees. `to` can also be a list of up to 10 people: one send starts one group thread, and a reply reaches everyone in it.
- **Structured requests.** A message can carry a request (`review-pr`, `pair`, `question` and so on) with repo, branch, folder and links. The Inbox page is read-only: it shows each thread with the earlier thread it replies to, and your agent does the rest.
- **Reminders.** `bab_remind` keeps private reminders, due on a date or at a time of day. They arrive at your next prompt, and you can mark them done or snooze them.
- **People.** `bab_people` lists the directory, the maintainers, each person's home team, and named contacts for knowledge areas, so an agent knows who to ask when BAB has no answer.
- **New devices.** Your sessions hear when a new device connects as you, and the Your devices page lets you forget one.

## Agent fleets

- **Key-value store.** `bab_kv` offers `get`, `set`, compare-and-swap, `incr`, `lock`, `unlock`, `renew` and `throttle`, all atomic. A lock answers with its holder and is never broken; a throttle books one shared slot per interval, so 50 agents calling at once get 50 slots, one interval apart. Every key needs a time-to-live (24 hours at most, one hour in a shared namespace). Never secrets or personal data. See [Key-value store](kv.md).
- **Files.** `bab_files` puts, lists, shares and deletes files, 25 MB per file and 100 MB per person by default, with an expiry of 14 days (30 at most). Bigger files go through a one-time upload link and plain `curl`. See [Files](files.md).

## BAB Tasks

A Kanban board for your agents. An optional, private page where a person sees what their own agents publish: initiatives with progress, open questions with their age, upkeep health, links, and a work log. The page only shows; there are no buttons to act on, so it works whatever tool an agent runs in. Installing the `bab-tasks` plugin is the opt-in. The person can export the log, delete everything, backfill the log from old sessions with a local tool, or let a report app they name read counts or entries. `bab_tasks` writes it. The optional `bab-tasks-audit` skill checks the page against PRs, tickets and files each night. See [BAB Tasks](tasks.md).

## Insight and upkeep

- **Usage page.** People enrolled, memories saved and still in BAB, searches and the share that a helpful reaction followed, weekly active people, messages, conversations and reminders per week, and measured agent time and tokens saved per reuse. Maintainers also see the searches with no good match. See [Measured savings](savings.md#measured-savings).
- **Live page.** The brain at work, drawn: dots for the people whose agents were at work, and a mark moves when an agent searches, saves or reuses a memory or sends a message, a note pops up to say what it was, and the picture plays the latest ones again when it goes still. The counts are coloured circles on the rim of the brain. It never says who did what, never shows fewer than three people, and shows no search text. A Replay button plays the whole history as a brain that grows, and plays it again until you pause it. The same things are listed in words under the picture.
- **Feedback.** Anyone can post a bug or an idea about BAB, from the footer or with `bab_feedback`. Colleagues vote and comment. Maintainers triage it, also with the `/bab:bab-triage` skill.
- **News.** The News page lists what changed, by day.
- **Keeps itself tidy.** Any request starts an hourly sweep: expired memories, deleted ones after 30 days, the audit log after 365 days, idle sessions, devices and connections. Stored text is masked again when new patterns are added. No background daemon.

## Use cases by team

| Team | Situation | With BAB |
|---|---|---|
| **Engineering** | A build breaks after a runtime upgrade. The agent does not know which version the pipeline expects. | The agent searches the error text, finds a colleague's note on the required version and fixes the build. |
| **Platform and SRE** | An incident comes back months later. The person who diagnosed it has moved teams. | The cause and the check that detects it early are a memory. The on-call agent can find it by searching the alert text. |
| **Agent fleets** | Twenty agents push changes to many repos at once and trip the host's rate limit. | Each agent books a slot on one shared `bab_kv` throttle and takes a lock per repo, so pushes are paced and never collide. |
| **Support** | Two customers report the same product error a week apart, handled by different people. | The first agent records the workaround. The second finds it in one search. |
| **Sales** | An agent drafts a quote with a discount that needs finance approval, and nobody told it. | A pinned house rule states the approval threshold, so the agent flags it before the quote goes out. |
| **Legal** | An agent prepares an NDA from an outdated template. | A decision record names the current template, who signs off and why the old one was retired. |

These rows are examples. Agents are told to record the shape of a rule or a fix, never client names, terms, secrets or personal data.
