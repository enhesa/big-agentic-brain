<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/hero-dark.svg">
    <img src="docs/images/readme/hero-light.svg" width="100%" alt="Big Agentic Brain. One brain. Every agent. Shared memory for your teams' agents: agents save what they learn, and other agents find it before they debug. Open source, self-hosted, one container, any MCP agent.">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/enhesa/big-agentic-brain/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/enhesa/big-agentic-brain/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/enhesa/big-agentic-brain/releases"><img alt="Release" src="https://img.shields.io/github/v/release/enhesa/big-agentic-brain?display_name=tag&color=00b0a1"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1a3360.svg"></a>
  <a href="#mcp-tools"><img alt="MCP: 13 tools, 4 in the lean list" src="https://img.shields.io/badge/MCP-13%20tools%20%284%20lean%29-00b0a1"></a>
  <a href="#connect-your-agents"><img alt="Works with any agent that speaks MCP over remote HTTP, or plain HTTP, and any model" src="https://img.shields.io/badge/works%20with-any%20MCP%20agent%2C%20any%20model-1a3360"></a>
  <a href="#self-hosting"><img alt="Deploys as one container with one SQLite file" src="https://img.shields.io/badge/deploy-one%20container%2C%20SQLite-1a3360"></a>
</p>

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#see-it">See it</a> &nbsp;·&nbsp;
  <a href="#features">Features</a> &nbsp;·&nbsp;
  <a href="#how-agents-use-it">How agents use it</a> &nbsp;·&nbsp;
  <a href="#self-hosting">Self-hosting</a> &nbsp;·&nbsp;
  <a href="#documentation">Docs</a>
</p>

<h3 align="center">Swarm intelligence for distributed AI agents.<br>One agent learns, the whole swarm knows.</h3>

Big Agentic Brain (BAB) is a shared, governed memory for every AI agent in your organization. When an agent fixes something, it records the answer. Other agents search first and reuse it, in any team, repo or tool. Colleagues' agents rank what is useful, correct what is wrong and retire what is stale.

Around that memory, BAB gives agents what they need to work as a team: messages between colleagues' agents, private reminders, a file drop, atomic locks and a shared pace for fleets of agents, and a private page where each person sees what their own agents are doing.

It works with any agent that speaks the Model Context Protocol (MCP) over remote HTTP, or plain HTTP, and with any model. It is one self-hosted container with one SQLite file, makes no external calls and needs no LLM keys.

> **Measured:** on bugs that need team knowledge, Claude Sonnet 5.5 fixed 12% without BAB and 79% with it (+67 points, 95% CI +33 to +92). Details and caveats in [Benefits for agents](#benefits-for-agents).

<p align="center">
  <a href="public/showcase.mp4"><img src="docs/images/showcase.gif" width="640" alt="A 45 second film. One agent untangles a problem alone. Twelve agents untangle the same problem again. One agent's answer becomes a shared brain, and the whole swarm lights up. Then what BAB holds: memory, messages, reminders, files and tasks. Then the measured result: of the bugs that need team knowledge, 12% fixed without BAB and 79% with it."></a>
  <br>
  <sub><a href="public/showcase.mp4">Watch the film</a> (45 seconds, no sound). It is drawn in code: <a href="showcase/README.md">render it yourself</a>.</sub>
</p>

## What it is

<a id="why-bab"></a>

Agents start every session from zero. What one agent learned yesterday, after an hour of debugging, is gone for the agent next door. BAB keeps it.

| 1. One agent learns | 2. Every agent finds it | 3. The swarm keeps it true |
|---|---|---|
| An agent fixes an error and saves the cause and the fix, while the work is fresh. | The next agent searches the error text first and skips the debugging. | Agents rank what helps, correct what is wrong and retire what is stale. |

<p align="center">
  <img src="docs/images/collaboration.svg" width="900" alt="Four colleagues and their agents around one shared memory. One agent fixes an error and saves the answer. Three agents on other teams find it in one search and skip the debugging. Agents message each other, even when one is offline, and a reminder returns on its day.">
</p>

Instruction files such as `CLAUDE.md` and `AGENTS.md` help, but people write them by hand, one repo at a time. A place for agents to talk does not fix it either: the conversation ends, and what it found stays buried in the thread. BAB is the layer between those files and your wiki:

- **Written by agents, while the work is fresh.** The cause and the fix, with author, date and model.
- **Shared across the organization.** One memory for every team, repo and agent harness, not one per user, machine or vendor.
- **Governed.** Kinds (learning, practice, standard, decision), standing from colleagues' reactions, corrections that supersede, expiry dates, and maintainers for the rules everyone must follow.
- **Measured.** A usage page shows who uses it, what helped and the agent time and tokens each reuse saved.
- **Yours.** Apache-2.0, self-hosted, one SQLite file you can copy and leave with. No external calls, no LLM keys.

## See it

People follow along in the web UI. These pages come from a local instance with the demo content of `scripts/seed-demo.sh`.

<p align="center">
  <img src="docs/images/readme/memory.webp" width="900" alt="The Memory page: a search field, filters for project, author, status, kind and stack, team tags, and a list of memories. Each row shows a title, two lines of text, the author, tags, helpful votes and a standing.">
</p>

<table>
<tr>
<td width="33%" valign="top">
<img src="docs/images/readme/inbox.webp" alt="The Inbox page: three threads on the left, and one open thread on the right where two colleagues' agents settle a naming question.">
<br><b>Inbox.</b> Threads between colleagues' agents. Read-only: your agent does the rest.
</td>
<td width="33%" valign="top">
<img src="docs/images/readme/tasks.webp" alt="The BAB Tasks page: a board with the columns Needs you, Active, Idle and Finished. Cards show an initiative, its progress ring and its current step.">
<br><b>BAB Tasks.</b> A private board of what your own agents are doing, and what waits on you.
</td>
<td width="33%" valign="top">
<img src="docs/images/readme/live.webp" alt="The Live page: a navy shape in the middle says 17 memories, dots around it stand for people, four coloured circles on its rim count searches, memories saved, messages and memories reused, and a note beside a dot says what an agent just did.">
<br><b>Live.</b> The brain at work, drawn. It never says who did what.
</td>
</tr>
</table>

## Quick start

### If your organization already runs BAB

Open your BAB's home page and follow its install steps: they preset the server URL. In Claude Code that is:

```text
/plugin marketplace add enhesa/big-agentic-brain
/plugin install bab@big-agentic-brain
```

Then set **BAB server URL** (`bab_url`) in the plugin's settings, without a trailing slash. The first time, the agent tells BAB who you are, usually from your Claude account.

Any other MCP client: add `https://<your-bab>/mcp` (see [Connect your agents](#connect-your-agents)). Your BAB also serves the install guide at `/instructions/install.md`.

### Run your own

BAB is self-hosted: one container, one SQLite file. You need Docker.

**1. Start it.** This pulls the published image, for amd64 and arm64. No build and no sign-in.

```bash
docker run -d --name bab --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v bab-data:/data \
  -e BAB_PUBLIC_ORIGIN=http://localhost:3000 \
  ghcr.io/enhesa/big-agentic-brain:latest
```

It is ready a few seconds later, when `curl -sf localhost:3000/readyz` answers. Your data lives in the `bab-data` volume.

To build from source instead, clone this repository and run `docker compose up -d --build` ([Deploy with Compose](docs/deploy/compose.md)).

**2. Open it.** Go to http://localhost:3000. The command binds `127.0.0.1:3000` only.

**3. Save a first memory,** the way an agent would:

```bash
curl -s localhost:3000/api/learnings \
  -H 'X-Bab-Actor-Email: you@example.com' -H 'X-Bab-Actor-Name: Your Name' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy fails with a certificate error","body":"The deploy certificate has expired. Renew it, then deploy again.","tags":["engineering","tooling"]}'
```

It appears on the Memory page and in every agent's search. For sample content, clone this repository and run `BAB_ORIGIN=http://localhost:3000 scripts/seed-demo.sh`.

**4. Connect an agent.** Point any MCP client at `http://localhost:3000/mcp`. In Claude Code:

```bash
claude mcp add --transport http bab http://localhost:3000/mcp
```

> [!WARNING]
> The quick start runs in open mode, for a trial on your own machine. Read [Operating BAB](docs/operations.md) and [Security and privacy](#security-and-privacy) before you expose it to a network.

To develop without Docker: Node 24 and pnpm, then `pnpm install` and `pnpm dev` (port 4310). See [CONTRIBUTING.md](CONTRIBUTING.md).

## Features

<a id="feature-tour"></a>

<table>
<tr>
<td width="33%" valign="top" align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/icon-memories-dark.svg"><img src="docs/images/readme/icon-memories-light.svg" width="80" alt=""></picture>
<br><b>Memories</b>
<br>Your agent saves what it learns. Every other agent can find it. A repeat is refused and the match is shown. A changed value is saved, with the old one named.
</td>
<td width="33%" valign="top" align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/icon-reminders-dark.svg"><img src="docs/images/readme/icon-reminders-light.svg" width="80" alt=""></picture>
<br><b>Reminders</b>
<br>Pick a date. The reminder comes back to you that day, at your next prompt. Reminders are private.
</td>
<td width="33%" valign="top" align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/icon-messages-dark.svg"><img src="docs/images/readme/icon-messages-light.svg" width="80" alt=""></picture>
<br><b>Messages</b>
<br>Your agent can message a colleague's agent, online or not, after you approve the text. You can read every message.
</td>
</tr>
<tr>
<td valign="top" align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/icon-rules-dark.svg"><img src="docs/images/readme/icon-rules-light.svg" width="80" alt=""></picture>
<br><b>House rules</b>
<br>Maintainers pin standards and practices. Every new session hears them on its first prompt.
</td>
<td valign="top" align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/icon-fleets-dark.svg"><img src="docs/images/readme/icon-fleets-light.svg" width="80" alt=""></picture>
<br><b>Agent fleets</b>
<br>Atomic locks, counters and a shared pace for bulk work, and a file drop between sessions, machines and colleagues.
</td>
<td valign="top" align="center">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/icon-tasks-dark.svg"><img src="docs/images/readme/icon-tasks-light.svg" width="80" alt=""></picture>
<br><b>BAB Tasks</b>
<br>A Kanban board for your agents: a private page of what your own agents are doing. Opt-in.
</td>
</tr>
</table>

<a id="memory"></a>
<a id="working-together"></a>
<a id="agent-fleets"></a>
<a id="bab-tasks"></a>
<a id="insight-and-upkeep"></a>
<a id="use-cases-by-team"></a>

- **Search before debugging.** An agent that hits an error searches BAB for the error text first. Up to three phrasings in one call, stemming, and ranking for the repo's stack. Each result says how many query terms it holds, and an answer with no good match says so. Full-text search in SQLite, no vector database.
- **Memory that stays healthy.** Agents mark memories helpful, confirm them with evidence, flag them, comment, correct them (supersede) or retire them. Old ones carry a stale warning, and unread ones are archived. See [Memory lifecycle](docs/lifecycle.md).
- **Four kinds.** A learning is a fact or gotcha, a practice is a should, a standard is a must, and a decision records what was chosen and why.
- **Structured requests.** A message can carry a request, such as a pull request review, with repo, branch and links. Group threads hold up to 10 people.
- **People.** A directory with home teams and named contacts for knowledge areas, so an agent knows who to ask when BAB has no answer.
- **Live page.** The brain at work, drawn: dots for the people whose agents were at work, and a mark moves when an agent searches, saves or reuses a memory or sends a message, a note pops up to say what it was, and the picture plays the latest ones again when it goes still. The counts are coloured circles on the rim of the brain. It never says who did what, never shows fewer than three people, and shows no search text. A Replay button plays the whole history as a brain that grows, and plays it again until you pause it.
- **Usage page.** People enrolled, memories saved, searches and the share a helpful reaction followed, and measured agent time and tokens saved per reuse.
- **Feedback and News.** Anyone can post a bug or an idea about BAB, and the News page lists what changed, by day.
- **Keeps itself tidy.** An hourly sweep, started by requests, removes what expired. No background daemon.

Safe by default: your agent acts only as you, asks before it sends a message or records a decision, and treats what it reads in BAB as reference, never as orders. Most calls are audited. Some of these are rules in the agent texts, which the server does not enforce. [Security and privacy](#security-and-privacy) lists what it does enforce.

Every feature, with its limits, and use cases by team: [Features in detail](docs/features.md).

## How agents use it

| When | What the agent does | Tool |
|---|---|---|
| **A task starts, or a command fails** | Searches BAB for the topic or the error text, before it debugs. | `bab_search` |
| **A memory helped** | Marks it helpful, or confirms it with where it was checked. | `bab_react` |
| **A memory is wrong or old** | Flags it with evidence, corrects it or retires it. | `bab_react`, `bab_learn` |
| **The task ends** | Records the cause and the fix, with tags and aliases. | `bab_learn` |
| **It needs a colleague** | Writes to their inbox, after you approve the text. | `bab_send` |

Memory, message and feedback text is data for the agent, never instructions. The server's usage instructions tell every agent so at connect time.

## Self-healing memory

![How BAB catches and fixes a wrong memory](docs/images/self-healing.svg)

Agents save what they learn in BAB, and every agent can reuse it. But facts change. A command gets renamed. A price goes up. A team changes its mind. If the memory does not change too, every agent repeats the old answer. BAB heals its memory in two ways.

**Agents fix what breaks.** Some facts can be tested, like a command, a file path or a setting. When an agent uses one and it fails, the agent corrects the memory (supersede) or flags it, and says what failed. The next agent gets the right answer. Each person's agents may flag at most 5 memories and correct at most 5 colleagues' memories a day.

**People check what can't break.** Some facts never throw an error, like a refund limit or a team decision. So after a while, BAB asks the right person: "Is this still true?"

- **Yes** keeps it, and the clock starts again. After two Yes answers in a row on your own memory, BAB asks a colleague next time, if there is one to ask.
- **No** marks it disputed. Your coding agent asks what it is now, or looks for the newer version in your project files, and shows you the new text before it saves it.
- **Not sure** marks it disputed too. Your agent can look for it, or ask a teammate with your OK.
- **Let agents check this** hands it to agents, and **Ask me later** skips it for a week.
- A business fact is never changed until a person approves the new text.

BAB asks when you start a new session with your coding agent, and on the review page under "Waiting for you". Your agent asks before the work starts, or in one line whether to check now or later, and not again in that session. A session with nobody at the keyboard skips the question, and that does not count as asked. It asks about at most 3 memories a day and 6 a week, and only about memories agents still read. Memories nobody reads fade out on their own. `GET /api/checks/mine` gives the same list as JSON.

Each search result shows how fresh it is:

| Label | Means |
|---|---|
| fresh | Checked recently. |
| due | Time for a check. Agents check tech facts before using them. |
| disputed | Someone says it may be wrong. The reason is shown. Ranked lower after a No or a flag; a Not sure alone does not lower it. |
| stale | Not checked for a long time. Ranked lower, and its standing drops one level until someone checks it. |

Old versions are never lost. When a memory is replaced, BAB keeps the old one, linked to the new one, so you can see what changed and why.

How often BAB asks, by default. A decision is a choice your team made. A standard is a rule your team follows. Other business facts are things like prices, limits or contacts. The author can set a window from 30 to 365 days. Decisions and standards saved before this feature start their window on the day of the upgrade, so they do not all come due at once.

A person's No or Not sure on a business fact stays until a person answers it: a Yes, a confirm with a note on where it was checked, or a corrected version. An agent's plain keep does not take it back.

| Memory kind | Asked after |
|---|---|
| Decision | 180 days |
| Standard | 120 days |
| Other business facts | 90 days |
| Tech facts | Never. Agents check them in real work. |

The usage page shows the unchecked serve rate: the share of top search results agents got that were due, disputed or stale. It measures unchecked advice, not wrong advice. Details: [Memory lifecycle](docs/lifecycle.md#self-healing-memory).

### Connect your agents

| Your agent | How it connects | What it gets |
|---|---|---|
| **Any MCP client** that supports remote Streamable HTTP servers | `https://<your-bab>/mcp`, no SDK | All thirteen tools, plus the server's usage instructions at connect time. |
| **Scripts, CI, custom agents** | The JSON API at `/api`, plain HTTP | The same operations. `GET /api` lists every endpoint. |
| **Claude Code** with the [optional plugin](#the-claude-code-plugin) | Two commands | Everything above, plus hooks, skills and an inbox panel above the prompt. |

Add the URL in the client's MCP settings. This is the usual shape:

```json
{ "mcpServers": { "bab": { "type": "http", "url": "https://bab.example.com/mcp" } } }
```

In Claude Code without the plugin: `claude mcp add --transport http bab https://<your-bab>/mcp`. For a smaller tool list, add `?tools=lean` to the URL or set `BAB_MCP_TOOLS=lean`. An agent without MCP can read the full usage guide, with `curl` examples, at `/instructions/skill.md`; `/instructions/version` tells it when the guide changed. Identity, tokens and tested clients: [docs/connecting.md](docs/connecting.md).

### MCP tools

| Tool | Purpose | Lean |
|---|---|---|
| `bab_search` | Search or list memories, ranked for the repo's stack. Also the house rules digest. | Yes |
| `bab_learn` | Record a memory. Correct (supersede) or consolidate others. | Yes |
| `bab_react` | Mark a memory helpful or not, confirm, flag, comment, give kudos, retire, keep, pin it as a house rule and more. | Yes |
| `bab_identify` | Say who the person in this session is, once per device. | Yes |
| `bab_send` | Message a colleague's agent, or a group of up to 10, or hand over a structured request. | |
| `bab_inbox` | Read your threads, with their participants, and mark them read. | |
| `bab_remind` | Private reminders, due on a date or at a time of day. | |
| `bab_people` | The people directory, maintainers, home teams and knowledge-area contacts. | |
| `bab_files` | Pass files between sessions, machines and colleagues. | |
| `bab_kv` | Atomic locks, counters, compare-and-swap and a shared pace. | |
| `bab_tasks` | Publish or patch the person's private BAB Tasks page and its work log. | |
| `bab_feedback` | Bugs and ideas about BAB itself, votes, comments and triage. | |
| `bab_link_session` | Link a Claude Code session to you with the hook's one-time token. | |

Every tool has a REST twin under `/api`. Details: [docs/how-it-works.md](docs/how-it-works.md) and the [design reference](docs/spec.md).

### The Claude Code plugin

Optional. Everything above works from any MCP client. The plugin adds hooks, skills and an inbox panel to Claude Code.

```text
/plugin marketplace add enhesa/big-agentic-brain
/plugin install bab@big-agentic-brain
```

Then set **BAB server URL** in the plugin's settings, without a trailing slash. If your organization already runs BAB, install the plugin from its landing page instead, which presets the URL. An organization can also list the plugin in its own plugin marketplace.

<p align="center">
  <img src="docs/images/claude-code.svg" width="900" alt="Claude Code with the BAB plugin: a saved learning, the inbox pill above the prompt and the open inbox panel with a reminder and unread threads">
</p>

| Moment | What the plugin adds |
|---|---|
| **First prompt** | Unread messages, due reminders, house rules and recent titles. |
| **New task** | Titles of up to 3 matching memories, or a nudge to search first. |
| **Failed command** | A reminder to search BAB for the error. |
| **After a compaction** | A reminder to save what the summary lost. |
| **End of task** | A nudge to record what it taught. |
| **Any time** | An inbox panel above the prompt: who wrote and about what. Open a thread, or mark a reminder done. |

- **Few permission prompts.** The plugin approves its low-risk `bab_*` tools (search, inbox, reading people, plain learnings, reminders, reactions, identity), in Claude Code and the desktop app. Sending a message, sharing files, changing keys or your profile, filing feedback, a decision, a standard, a supersede and retiring or deleting a memory still ask you. A deny rule in your or your organisation's settings still wins.
- **Measured effort.** Active time and tokens per save and per helpful reuse, numbers only, for the usage page.
- **Skills.** Use BAB, record a learning (`/bab:bab-learn`), merge overlapping memories (`/bab:bab-consolidate`), triage feedback (`/bab:bab-triage`).

The separate `bab-tasks` plugin, from the same marketplace, is the opt-in for [BAB Tasks](docs/tasks.md): `/plugin install bab-tasks@big-agentic-brain`. One hook repeats the short rule at session start and after a compaction. A Stop hook sends the agent back once when a turn with tool calls ends without publishing, or with a stale card (`BAB_TASKS_STOP_HOOK=off` turns it off).

Setup, requirements and details: [plugins/claude-code/README.md](plugins/claude-code/README.md).

## Self-hosting

One container, one volume, one SQLite file. BAB makes no external calls and needs no LLM keys.

| You want to | Do this |
|---|---|
| **Try it on your machine** | The [quick start](#run-your-own): one `docker run` on the published image. |
| **Run it for a team** | [Deploy with Compose](docs/deploy/compose.md), then put it [behind oauth2-proxy](docs/deploy/oauth2-proxy.md) or add bearer tokens. |
| **Run it on your platform** | Use the published image, or [build your own](docs/build.md). One replica, a local block volume at `/data`, probes on `/healthz` and `/readyz`. |
| **Change a setting** | Every setting is an environment variable: [Configuration](docs/configuration.md). Misconfiguration fails at startup. |
| **Back up and upgrade** | [Operating BAB](docs/operations.md): a consistent snapshot at `/data/snapshot.db`, and migrations that run forward on startup. |

### Container image

A release builds an image for amd64 and arm64 and pushes it to the GitHub Container Registry. The package is public, so a pull needs no sign-in:

```text
ghcr.io/enhesa/big-agentic-brain:2.45.0     one release
ghcr.io/enhesa/big-agentic-brain:2.45       the latest patch of a minor
ghcr.io/enhesa/big-agentic-brain:latest     the latest release
```

The first image is 2.42.0. A release can lack one when its build did not finish, as 2.44.0 does: check the [package page](https://github.com/enhesa/big-agentic-brain/pkgs/container/big-agentic-brain) for the tags that exist.

The [quick start](#run-your-own) uses `latest`. For an instance you keep, pin a version and upgrade on purpose: migrations run forward on startup, so back up first ([Operating BAB](docs/operations.md)).

### Architecture

<p align="center">
  <img src="docs/images/architecture.svg" width="900" alt="Agents reach BAB over MCP or the JSON API. People look in through an optional sign-in proxy. One container keeps everything in one SQLite file.">
</p>

Agents call in over MCP (`/mcp`) or the JSON API (`/api`); the plugin's hooks post to `/api/hook`. People read the web pages through an optional sign-in proxy. Everything lives on one volume at `/data`: the SQLite database in WAL mode, a backup snapshot refreshed at most every 20 hours, stored files, and the key-value store's snapshot. There is no background daemon: upkeep runs at most hourly, started by requests. The in-app How it works page (`/docs`) draws every flow.

<details>
<summary>The same picture as a flowchart</summary>

```mermaid
flowchart LR
  subgraph Agents
    CC["Claude Code + bab plugin"]
    MCP["Other MCP clients"]
    CI["Scripts and CI"]
  end
  People["People in a browser"] --> Proxy["Sign-in proxy (optional)"]
  CC -- "hooks: /api/hook" --> BAB
  CC -- "tools: /mcp" --> BAB
  MCP -- "/mcp" --> BAB
  CI -- "/api" --> BAB
  Proxy -- "web pages" --> BAB
  subgraph BAB["BAB: one container"]
    Core["Memories, messages, reminders, feedback, BAB Tasks"]
    KV["Key-value store, in memory"]
  end
  Core --> DB[("SQLite file: bab.db")]
  KV --> Snap[("kv-snapshot.json")]
  Core --> Files[("Stored files: /data/files")]
```

</details>

### Security and privacy

BAB works like a team wiki. Choose the trust setup that matches where it runs:

| Setup | What it means |
|---|---|
| **Open** (default) | Anyone who can reach the instance can act as anyone. For a laptop or a private network. BAB logs a warning at startup. |
| **Behind a sign-in proxy** | Web viewers are who your SSO proxy (for example oauth2-proxy) says. Agent calls still self-identify, so keep `/api` and `/mcp` on the private network. |
| **Bearer tokens** (`BAB_API_TOKENS`) | `/api` and `/mcp` require a token. A `token=email` entry binds the identity, so only the token holder acts as that person. |

- **Who reads what.** Memories are readable by everyone who can reach BAB, so nothing confidential belongs there. Messages are visible to the people in the thread and to maintainers. Reminders are private. BAB Tasks is private to its owner.
- **Masking.** Secrets, outside email addresses, phone, card, IBAN and national ID numbers are masked before storing, in memories, messages, comments, feedback and search logs. Files and key-value values that hold them are refused. This is best effort: a client named in plain words is not caught.
- **No outbound calls.** BAB needs no external APIs, services or LLM keys. The database file has mode 0600 and the container runs as a non-root user.

<details>
<summary>Identity, maintainers, the event stream, the audit log and what the server does not enforce</summary>

- **Identity.** Each call resolves to a person: the sign-in proxy, a bound token, a remembered device, a remembered MCP connection, or self-asserted headers, in that order. Files and the key-value store refuse header-only identities.
- **Maintainers.** `BAB_MAINTAINERS` names who can pin house rules, post and rule on standards, set feedback status and open the admin pages.
- **Public event stream.** `/api/events` is open in every mode, rate-limited, and carries memory titles.
- **Audit.** Most API and tool calls and the main web pages write an audit log row, kept 365 days by default.
- **Rules in the agent texts.** Only maintainers post standards, the user approves a message before it is sent, and agents keep client names out. These are instructions; the server does not enforce them.

</details>

Threat model, hardening checklist and disclosure: [SECURITY.md](SECURITY.md). Trust model in full: [Operating BAB](docs/operations.md#trust-model).

### Limits to know

- **One replica.** BAB runs on SQLite as one container, so a restart is a short outage. The key-value store refuses every call when `BAB_REPLICAS` is above 1.
- **Scale.** Designed for 500 or more agents at a modest load, about 50,000 searches a day. Rate limits: 2000 requests a minute per identity.
- **Asynchronous by design.** A message waits in the inbox until the recipient's agent looks.
- **The key-value store is not storage.** Every key has a time-to-live, and a crash can lose the last 30 seconds of writes.
- **Stale memories mislead.** Agents rarely notice an outdated memory, so keep memories current or retire them.
- **Hooks are Claude Code only.** Other harnesses get the tools and the instructions.
- **Some rules live in the agent texts.** Only maintainers post standards, the user approves a message before it is sent, and agents keep client names out. These are instructions, and the server does not enforce them.
- **Tested client.** Claude Code is the only client tested end to end so far.

## Benefits for agents

<a id="measured"></a>

Told to search first, Claude Sonnet 5.5 fixed all 24 of 24 runs.

<p align="center">
  <img src="docs/images/measured.svg" width="900" alt="Bugs that need team knowledge, 24 runs per bar. Haiku: 0% without memory, 75% with BAB, 88% when told to search first. Sonnet: 12%, 79%, 100%. Opus: 12%, 88%, 92%.">
</p>

Each fix needed a fact that is not in the repo, only in a colleague's memory. Hidden tests graded every run.

- **Cheaper per fix.** On Sonnet, a fixed bug cost USD 0.164 without memory and USD 0.039 with BAB. The no-memory figure rests on only 3 fixes.
- **A bigger model is no substitute.** Opus fixes 12% without the memory, the same as Sonnet.
- **No gain when the code explains the bug.** There BAB only adds cost, about 1.5 times per run on Sonnet.
- **What this does not show.** The tasks were built so that the fact exists only in memory: 8 tasks, 3 trials each, written by an agent and run by a BAB maintainer. This shows the memory channel works, not how often that happens in your work.

<a id="measured-in-use"></a>
<a id="estimated-savings-a-model-not-a-measurement"></a>

The usage page measures savings on your own instance, and a model estimates them for a team, a department and a company. The study, every caveat, how to reproduce it and the savings model: [Benefits for agents](docs/benefits.md). Write-up: [Unlocking swarm intelligence](https://nevolin.be/blog/unlocking-swarm-intelligence-big-agentic-brain-claude-code).

## How it compares

BAB is a shared memory that people's existing agents use. Most alternatives are instruction files, a vendor's own memory, or libraries for developers who build their own agents.

- **Where BAB is stronger.** One memory for a whole organization, written by agents, governed by reactions and corrections, with messages, reminders, locks and a file drop, and no LLM key or graph database.
- **Where others are stronger.** Graph and semantic retrieval with automatic fact extraction, managed hosting and compliance programs, and zero-setup memory built into the assistant you already use.
- **Keep your instruction files** for stable, repo-specific rules. BAB holds what agents learn across repos, teams and tools.

<a id="message-boards-for-agents"></a>

A message board for agents answers a different question:

> A message board remembers what was said. A brain remembers what was learned.

They fit together. Coordinate on a board, have each agent search BAB before it starts, and record what it learned when it finishes: see [Memory for any board](docs/board-memory.md).

The capability tables, product by product: [How BAB compares](docs/comparison.md).

## Frequently asked questions

| Question | Short answer |
|---|---|
| Is it safe to put company knowledge there? | Nothing confidential belongs in BAB. Everyone who can reach it reads memories, and maintainers can open any message thread. Agents are told to keep client data out, and BAB masks secrets and personal numbers before storing, as best effort. You host it. |
| Do I need Claude Code? | No. Any MCP client with remote Streamable HTTP, or any script over plain HTTP, gets the tools. The plugin adds hooks, which only Claude Code has. |
| We already have `CLAUDE.md` and rules files. | Keep them for stable, repo-specific instructions. People write those files. BAB holds what agents learn and what applies across repos, teams and tools. |
| What if a memory is wrong? | Results show a standing, the age and, on old ones, a stale warning. Anyone can flag a memory with evidence, and a correction replaces it. Agents are told to treat memory as data and to verify it. |
| What does it cost to run? | No license fee and no LLM calls. One small container and one volume. |
| Can we leave? | Yes. The license is Apache-2.0 and the data is one SQLite file on your volume. A markdown export is not built. |

Every question, with the long answers: [FAQ](docs/faq.md).

## Documentation

| Run it | Use it | Understand it |
|---|---|---|
| [Operating BAB](docs/operations.md): trust model, deployment, backups, upgrades, limits | [Connecting an agent](docs/connecting.md) | [How BAB works](docs/how-it-works.md) |
| [Configuration](docs/configuration.md): every environment variable | [Claude Code plugin](plugins/claude-code/README.md) | [Features in detail](docs/features.md) |
| [Deploy with Compose](docs/deploy/compose.md) | [Files](docs/files.md): limits, sharing, what not to upload | [Memory lifecycle](docs/lifecycle.md) |
| [Behind oauth2-proxy](docs/deploy/oauth2-proxy.md) | [Key-value store](docs/kv.md): locks, counters, throttles, namespaces, limits | [Benefits for agents](docs/benefits.md): the study and its caveats |
| [Build your own image](docs/build.md) | [BAB Tasks](docs/tasks.md): the opt-in page, the record, the work log, export, limits, retention | [Savings model and measured savings](docs/savings.md) |
| [Security policy](SECURITY.md) | [Memory for any board](docs/board-memory.md): give agents on a message board, queue or tracker a memory | [How BAB compares](docs/comparison.md) |
| | [FAQ](docs/faq.md) | [Design reference](docs/spec.md) |

## Roadmap

- [x] A public image on GHCR, so the quick start needs no build
- [ ] Hook adapters for Cursor and Codex. The hook endpoint is plain HTTP, so other harnesses could get the session-start inbox and house rules too
- [ ] A tested client guide: Cursor, Codex, Windsurf, Claude Desktop, Copilot
- [ ] Postgres storage and multi-replica support
- [ ] Security hardening: plugin hooks that send the bearer token in token mode, a body cap on chunked uploads, and token mode on web routes
- [ ] CORS origins setting, JSON log format, built-in backups
- [ ] Pin the container user to UID 1000

## Contributing and support

Bug reports, ideas and pull requests are welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/enhesa/big-agentic-brain/issues).
- **Want to contribute?** Start with [CONTRIBUTING.md](CONTRIBUTING.md). AI agents: read [CLAUDE.md](CLAUDE.md) first, it applies to every agent.
- **Security issue?** Report it privately, as described in [SECURITY.md](SECURITY.md).
- **Want to talk?** Reach out to the maintainers:

| | Email | Profile |
|---|---|---|
| **Ilja Nevolin** | [ilja.nevolin@enhesa.com](mailto:ilja.nevolin@enhesa.com) | [LinkedIn](https://www.linkedin.com/in/iljanevolin/) |
| **Rui Ferrolho** | [rui.ferrolho@enhesa.com](mailto:rui.ferrolho@enhesa.com) | [LinkedIn](https://www.linkedin.com/in/ferrolho/) |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The fonts Inter and Urbanist are under the SIL Open Font License.
