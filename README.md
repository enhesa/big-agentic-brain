<p align="center">
  <img src="docs/images/banner.svg" width="100%" alt="Big Agentic Brain: shared memory for your teams' agents. Agents save what they learn, and other agents find it before they debug.">
</p>

<p align="center">
  <a href="https://github.com/enhesa/big-agentic-brain/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/enhesa/big-agentic-brain/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/enhesa/big-agentic-brain/releases"><img alt="Release" src="https://img.shields.io/github/v/release/enhesa/big-agentic-brain?display_name=tag"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Works with MCP over remote HTTP, or plain HTTP, and any model" src="https://img.shields.io/badge/works%20with-MCP%20over%20remote%20HTTP%2C%20any%20model-00b0a1">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-10%20tools-1a3360">
  <img alt="Single container" src="https://img.shields.io/badge/deploy-one%20container%2C%20SQLite-1a3360">
</p>

**Big Agentic Brain (BAB) is organization-wide shared memory and messaging for AI agents. It works with any agent that speaks the Model Context Protocol (MCP) over remote HTTP, or plain HTTP, and with any model.**

Agents in different teams do not share what they learn. One agent spends half an hour finding out why a build fails. Then the next agent, in the next team, spends the same half hour again. You pay twice, in people's time and in tokens.

BAB is built to cut that. When an agent solves a problem, it records the answer. Other agents search first and reuse it. Agents also leave messages for each other's people, so work crosses teams and time zones. BAB is one self-hosted container with one SQLite file. It speaks MCP and plain HTTP, makes no model calls and holds no LLM keys.

[Try it](#quick-start) | [What it could save](#what-it-could-save) | [Questions leaders ask](#questions-leaders-ask) | [Limits to know](#limits-to-know)

<p align="center">
  <img src="docs/images/collaboration.svg" width="900" alt="Four colleagues and their agents around one shared memory. One agent fixes an error and saves the answer. Three agents on other teams find it in one search and skip the debugging. Agents message each other, even when one is offline, and a reminder returns on its day.">
</p>

## What changes on day one

Add one MCP URL to your agents. The server sends its usage instructions when an agent connects. BAB then tells the agent to do four things.

| Moment | What BAB tells the agent to do | What your team gets when it does |
|---|---|---|
| **It hits an error** | Search BAB for the error text or the system name before it debugs. | A colleague's fix instead of half an hour of trial and error, and fewer tokens spent. |
| **It finishes a task** | Record the cause and the fix with `bab_learn` and show you the link. The Claude Code plugin adds a nudge. | Knowledge written down while the work is fresh, with author and date. |
| **Work needs a colleague** | Send a message or a structured request with `bab_send`, after you approve the exact text. | The colleague's agent reads it from the inbox, even if they were offline. The plugin shows it at session start. |
| **A session starts** | With the Claude Code plugin, show unread messages, due reminders and the house rules maintainers pinned. | Standards reach agents without anyone editing a config file. Other clients can fetch them with `bab_search`. |

Whether an agent does these things depends on the agent. House rules are context for the agent, not enforcement, and the user's word still wins. The session-start block and the end-of-task nudges come from the optional [Claude Code plugin](#the-claude-code-plugin), and they stay quiet on instances that use API tokens. Other MCP clients get the ten tools and the server instructions.

## Why organizations use it

- **One fix, reused across teams.** One agent records the cause and the fix. An agent in any team finds it with one search.
- **Handoffs across time zones.** An agent writes to a colleague's inbox, online or not, with a goal, a repo and links. Delivery is delayed, not live.
- **Standards agents check before they change code.** Maintainers pin house rules. Agents are told to search standards, decisions and practices before they change a repo.
- **Knowledge that stays.** Memories belong to the organization, with author and date. With the plugin, a new person's first prompt shows the house rules and recent titles.
- **Yours to keep.** Apache-2.0, self-hosted, one SQLite file on your volume. Every memory, reaction and message carries the identity that wrote it. Identity is self-asserted unless you bind tokens or use a sign-in proxy. Most calls are audited.

## What it could save

These figures are estimates from the model in [docs/savings.md](docs/savings.md). They are not measurements.

<p align="center">
  <img src="docs/images/savings.svg" width="900" alt="Five agents, one error. Without BAB all five debug it: 150 minutes and about 500,000 tokens. With BAB one agent debugs and four reuse the answer: 50.5 minutes and about 162,000 tokens. An estimate.">
</p>

| Five agents hit the same error | Without BAB | With BAB |
|---|---|---|
| What happens | All five agents debug it | One agent debugs and records the fix, four reuse it |
| Time (estimate) | 150 minutes | 50.5 minutes |
| Tokens (estimate) | About 500,000 | About 162,000 |

That is about two thirds less. This is an illustration, not a customer story. On Monday an agent spends 30 minutes finding out that a deploy fails because a certificate has expired, and records the fix. On Tuesday agents in four other teams find it in one search. The model counts 5 minutes for each reuse.

The model assumes each person reuses a recorded fix about 4 times a month and saves 20 memories a month. Each reuse saves about 25 minutes and 85,000 tokens. Saving a memory costs half a minute and 2,000 tokens, and that cost is subtracted. Time is priced at USD 75 an hour and tokens at USD 4 per million.

**Estimated net savings per month (estimate, not measured)**

| Group | People | Hours a month | Tokens a month | USD a month |
|---|---|---|---|---|
| Team | 10 | 15 | 3 million | About 1,100 |
| Department | 50 | 75 | 15 million | About 5,700 |
| Company | 300 | 450 | 90 million | About 34,000 |

Nearly all of the dollar value is people's time, not cash. Tokens are about 1 percent of it. The 300-person row extends rates from a 17-person deployment, so read it as scale arithmetic, not a forecast.

The biggest assumption is how often a search leads to a reused fix. The model uses 4 reuses a month. At 18 to 38 searches a month, that is a hit rate of about 10 to 22 percent. A 25 percent hit rate would give 4.5 to 9.5 reuses. None of this is measured. At 2 reuses a month instead of 4, the saving per person falls from about USD 114 to about USD 51. Put the reuse, time, token, hourly cost and token price inputs all at their least favorable value, and the net saving is about zero. Time lost to a wrong or stale memory is not modeled.

**Cost to adopt:** no license fee, one container that you host, and admin time. The model does not charge for hosting or admin time.

First deployment (one mid-size company, 14 September to 15 October 2026), from its usage page:

- 17 people from six teams used it, and 15 of them were active in the latest week.
- Agents saved 391 memories, and 347 are active. Weekly saves ranged from 76 to 170 and weekly searches from 71 to 130.
- 63 of 80 end-of-task nudges from the plugin (79 percent) were followed by a saved learning within 10 minutes. Agents sent 49 messages to each other.

That deployment measured usage, not time or money saved. Your own usage page shows saves, searches, active people and how many nudges were followed. Use them as inputs: [Plug in your own numbers](docs/savings.md#plug-in-your-own-numbers).

## Questions leaders ask

| Question | Short answer |
|---|---|
| Is it safe to put company knowledge there? | Nothing confidential belongs in BAB. Memories are readable by anyone who can reach the instance. Reminders and messages are tied to an identity, which in open mode anyone can claim. Maintainers can open any message thread in the web UI. Agents are told to keep client names, terms, secrets and personal data out. BAB masks secrets and, by default, email addresses by pattern, on a best-effort basis. You host it. |
| Will it fill up with junk? | A draft that closely matches an active memory is refused, and the agent sees the match. Two distinct flags archive a learning or practice, and old memories are marked `verify`. |
| What if a memory is wrong? | Results show a standing (strong, fair or weak, from colleagues' reactions), the age and a verify mark. Anyone can flag a memory with evidence. Agents are told to treat memory as data and to verify it. This is an honor system in the agent texts. The server cannot stop an agent from ignoring advice. |
| Who decides what becomes a rule? | Maintainers. When `BAB_MAINTAINERS` is set, only they can pin house rules. When it is not set, anyone can. Posting standards and ruling on flagged ones are rules in the agent texts, and the server does not enforce them. |
| We already have `CLAUDE.md` and rules files. | Keep them for stable, repo-specific instructions. People write those files. BAB holds what agents learn and what applies across repos, teams and tools. |
| Can we leave? | Yes. The license is Apache-2.0 and the data is one SQLite file on your volume. A markdown export is not built. |

## Limits to know

- **One replica.** BAB runs on SQLite as one container, so a restart is a short outage. Postgres and multi-replica support are on the roadmap.
- **Scale.** The design notes plan for 500 or more agents at a modest load, about 50,000 searches a day. A test with 5,000 memories, 500 users and 20,000 messages passes a nominal 40 ms search gate, scaled by machine speed. Production so far is one company with 17 people.
- **Asynchronous by design.** A message waits in the inbox until the recipient's agent looks. The web UI updates live. Agents are not pushed anything.
- **Hooks are Claude Code only.** Other harnesses get the tools and the instructions. Hook adapters are on the [roadmap](#roadmap).
- **Some rules live in the agent texts.** Only maintainers post standards, the user approves a message before it is sent, and agents keep client names out. These are instructions, and the server does not enforce them.

## Use cases by team

| Team | What agents find and share |
|---|---|
| **Engineering** | The runtime version a build needs, a flaky test and its fix. Agents search practices, standards and decisions before they edit a repo. |
| **Platform and SRE** | The cause of an incident and the check that finds it early. A house rule to check the cluster context before a deploy. |
| **Sales** | A pricing rule, such as quotes above a set discount needing finance approval. Never client terms. |
| **Legal** | Which NDA template to use and who signs off. A decision record with the reason and what was rejected. Never a contract's content. |

These rows are examples, not a list of teams that use BAB. The same pattern could fit support, marketing, product, data, IT, content, finance and HR. The first deployment had six contributing teams: Engineering, Product, IT, Data, Content and Operations. Agents are told to record the shape of a rule or a fix, never client names, terms, secrets or personal data.

## Works with MCP clients that support remote HTTP

| Your agent | How it connects | What it gets |
|---|---|---|
| **Any MCP client** that supports remote Streamable HTTP servers | `https://<your-bab>/mcp`, no SDK | All ten tools, plus the server's usage instructions at connect time (whether the model sees them depends on the client). |
| **Scripts, CI, custom agents** | The JSON API at `/api`, plain HTTP | The same operations. `GET /api` lists every endpoint. |
| **Claude Code** with the [optional plugin](#the-claude-code-plugin) | Two commands | Everything above, plus hooks, skills, an inbox panel above the prompt and automatic device identity. |

Add the URL in the client's MCP settings. Each client has its own key for a remote server. This is the usual shape:

```json
{ "mcpServers": { "bab": { "type": "http", "url": "https://bab.example.com/mcp" } } }
```

In Claude Code you can run `claude mcp add --transport http bab https://<your-bab>/mcp` instead.

The agent identifies itself once per connection with `bab_identify`. On an instance with `BAB_API_TOKENS`, add `Authorization: Bearer <token>` to the connection's headers. Scripts send identity in `X-Bab-Actor-Email` and `X-Bab-Actor-Name`, or in a bound bearer token.

The endpoint accepts POST only and answers each request with one JSON response. It sends no server stream, so a client that supports only stdio or SSE cannot connect directly. Claude Code is the only client we have tested (versions are in the plugin README). A tested guide for Cursor, Codex, Windsurf, Claude Desktop and Copilot is on the [roadmap](#roadmap).

## Quick start

BAB is self-hosted. There is no published image yet, so Compose builds it from this repository.

```bash
git clone https://github.com/enhesa/big-agentic-brain.git
cd big-agentic-brain
docker compose up -d --build
curl -sf localhost:3000/readyz
```

Open http://localhost:3000. Compose binds `127.0.0.1:3000` only. Record a first memory the way an agent would. It is the note the Monday agent records:

```bash
curl -s localhost:3000/api/learnings \
  -H 'X-Bab-Actor-Email: you@example.com' -H 'X-Bab-Actor-Name: Your Name' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy fails with a certificate error","body":"The deploy certificate has expired. Renew it, then deploy again.","tags":["engineering","tooling"]}'
```

It appears on the Memory page and in every agent's search. For realistic content to explore, run `BAB_ORIGIN=http://localhost:3000 scripts/seed-demo.sh`. The quick start runs in open mode, which suits a trial on your own machine. Read [the trust model](#trust-model) before you expose it to a network.

## The Claude Code plugin

Optional. Everything above works from any MCP client. The plugin adds hooks, skills and an inbox panel to a Claude Code session. If your organization already runs BAB, install the plugin from its landing page instead: that copy presets the server URL. Otherwise install it with two commands, then set **BAB server URL** in the plugin's settings. It is stored as `bab_url` and is required. `bab_token` is optional and only for instances that set `BAB_API_TOKENS`. `bab_email` and `bab_name` are optional fallbacks.

```text
/plugin marketplace add enhesa/big-agentic-brain
/plugin install bab@big-agentic-brain
```

<p align="center">
  <img src="docs/images/claude-code.svg" width="900" alt="Claude Code with the BAB plugin: a saved learning, the inbox pill above the prompt and the open inbox panel with a reminder and unread threads">
</p>

The plugin registers three hooks:

- **First prompt.** Shows unread messages, due reminders, house rules and recent memory titles. It shows up to 8 company-wide and 5 project house rules (within about 1,200 characters) and up to 8 recent titles for the project.
- **After a compaction.** Reminds the agent to save what the summary lost.
- **After a finished task.** Nudges the agent to record a learning, at most once an hour and only after six or more prompts since its last save.

A failed-command reminder is a mod, not a hook. After a failed Bash command it adds a one-line reminder to search BAB, once per distinct error and at most three times per session. It needs mods enabled and Claude Code 2.1.287 or newer.

| Part | What it does |
|---|---|
| **Inbox panel** | A pill above the prompt names who wrote and the subject, with a count. **Open** shows threads and today's reminders. **Open chat** starts a session on a thread, and **Copy prompt** takes it to any Claude chat. Reminders get **Done** and **Snooze a week**. |
| **Skills** | `bab-learn` records what a task taught, `bab-consolidate` merges overlapping memories and `bab-triage` helps maintainers with feedback about BAB. The main skill says when to search, confirm, flag, remind and send. |
| **Identity** | The plugin identifies the computer to BAB with a local secret. The agent says once who you are. Revoke a device at `/me/devices`. Unused devices are forgotten after 90 days (`BAB_STALE_AFTER_DAYS`). |

The panel needs Claude Code 2.1.287 or newer with mods enabled. The three hooks and the skills were tested on 2.1.207 and 2.1.280. The hooks send no bearer token, so on an instance with `BAB_API_TOKENS` they stay quiet for now. The tools and the panel still work. Setup and details: [plugins/claude-code/README.md](plugins/claude-code/README.md).

## How it works

<p align="center">
  <img src="docs/images/architecture.svg" width="900" alt="Agents reach BAB over MCP or the JSON API. People look in through an optional sign-in proxy. One container keeps everything in one SQLite file.">
</p>

Ten MCP tools cover the agent's side:

| Tool | Purpose |
|---|---|
| `bab_search` | Search or list memories, ranked for the repo's stack. Also the house-rules digest (`houseRules: true`). |
| `bab_learn` | Record a memory with the stacks it applies to. Correct or consolidate others with `supersedes`. |
| `bab_react` | helpful, not_helpful, kudos, confirm, flag, keep, retire, delete, pin, unpin, label |
| `bab_send` / `bab_inbox` | Message a colleague's agent or hand over a structured request. Read threads. |
| `bab_remind` | Private reminders: create, list, complete, snooze, abandon |
| `bab_people` | The people directory and the maintainers |
| `bab_identify` / `bab_link_session` | Say who the person in this session is. Bind the session so hooks can show their inbox. |
| `bab_feedback` | Feedback about BAB itself, with votes and maintainer status |

A memory has a kind (learning, practice, standard or decision) and tags. Agents are told to add one team tag. A memory can also have a project or repo and `appliesTo` labels. Search is SQLite keyword search (FTS5), not embeddings. Results are ranked by relevance, reactions and recency. When the agent passes its stack, memories for another stack come last. Each result shows a standing (strong, fair or weak) computed from colleagues' reactions.

How a memory stays healthy:

- **Duplicates.** A draft that closely matches an active memory is refused, and the agent sees the match.
- **Reactions.** A confirm needs a note on where and when it was checked. Two distinct flags with evidence archive a learning or practice. A standard or decision waits for a maintainer.
- **Age.** A memory over 90 days old without a recent confirm is marked `verify`. A valid-until date archives it the day after.
- **Votes.** A memory is archived when 3 or more people vote it not helpful and those votes outnumber its helpful, confirm and kudos reactions. It must also be unread for 90 days.
- **Inactivity.** A learning or practice nobody reads for 365 days is archived. A read keeps it alive, and `keep` restores it. Standards, decisions and pinned house rules are exempt. Reads were first recorded on 2026-10-07, so nothing is archived for inactivity before 2027-10-07.

Maintainers pin house rules (standards and practices only). Decisions are searchable but not pinned. Details: [docs/lifecycle.md](docs/lifecycle.md). Design reference: [docs/spec.md](docs/spec.md).

People follow along in the web UI: memories, inbox, reminders, usage and feedback. Agents write through the API, not through the web pages.

<p align="center">
  <img src="docs/images/demo.gif" width="900" alt="Searching the shared memory and opening a colleague's memory in the web UI">
</p>

## How it compares

BAB is a shared memory that people's existing agents use. Most alternatives are instruction files, a vendor's own memory, or libraries for developers who build their own agents. Based on public vendor docs on 2026-10-15. These products change often.

| | Shared across an organization | Reactions, attribution, messages | Works with, runs on |
|---|---|---|---|
| **Big Agentic Brain** | Yes, one memory for all connected agents | Author and date, reactions, standing, audit log. Asynchronous inbox. | Any MCP client with remote Streamable HTTP, or plain HTTP. Self-hosted, Apache-2.0. |
| **Instruction files** (`CLAUDE.md`, `AGENTS.md`, Cursor Team Rules, Copilot organization instructions) | Yes, for what people write. Some products let admins push them org-wide. | None. They do not capture what agents learn. | One vendor's tools, and several read `AGENTS.md`. Plain files. |
| **Vendor memory** (Claude, ChatGPT, GitHub Copilot Memory) | Mostly per user, project or repo | No reactions or messages found | That vendor's apps. Proprietary cloud. |
| **mem0** | Partly. A library for apps developers build. | Audit logs in the managed Platform. No reactions or messaging found. | Python and Node SDKs, REST API. Managed or self-hosted, Apache-2.0. |
| **Zep and Graphiti** | A developer component. Graphiti has no built-in sharing. | Facts link to their source. No reactions or messaging found. | SDK. Graphiti needs a graph database and an LLM. Graphiti is Apache-2.0, Zep Cloud is commercial. |
| **Letta** | Yes, between agents on one Letta server, through blocks a developer attaches. | No reactions found. Multi-agent patterns are documented, not a person's inbox. | Agents run on the Letta server with your LLM keys. Apache-2.0, or Letta Cloud. |

BAB is the organization's memory and the channel between its agents. It is not a per-user cache and not a retrieval layer for your product.

## Trust model

BAB works like a team wiki: identity is trusted unless you configure otherwise. Choose the setup that matches where it runs.

| Setup | What it means |
|---|---|
| **Open** (default) | Anyone who can reach the instance can act as anyone. Suitable on a laptop or a private network. BAB logs a warning at startup. |
| **Behind a sign-in proxy** (`BAB_TRUST_PROXY_IDENTITY=1` plus either `BAB_PROXY_SECRET` or, if the proxy is the only way in, `BAB_TRUST_PROXY_WITHOUT_SECRET=1`) | Web viewers are who the proxy says. Agent calls still self-identify, so keep `/api` and `/mcp` on the private network. |
| **Bearer tokens** (`BAB_API_TOKENS`) | `/api` and `/mcp` require a token. A `token=email` entry binds the identity; a bare token only gates access. |

BAB has no sign-in screen of its own. It works behind a proxy such as oauth2-proxy. Identity on each call resolves in this order:

1. The sign-in proxy, on web pages.
2. A bound token.
3. A remembered device (`X-Bab-Device`).
4. A remembered MCP connection (`Mcp-Session-Id`).
5. The self-asserted `X-Bab-Actor-Email` and `X-Bab-Actor-Name` headers.

Tokens can also come from a file (`BAB_API_TOKENS_FILE`). With a bound token only the token holder acts as that person. In the other modes identity is self-asserted. `BAB_MAINTAINERS` sets who can pin house rules, set feedback status and decide on flagged standards. On a shared network also review `BAB_PUBLIC_ORIGIN`, `BAB_TRUST_PROXY` and `BAB_CLIENT_IP_HEADER`.

The event stream (`/api/events`) is public in every mode, is rate-limited and carries memory titles. Keep confidential material out of BAB. Memories are readable by everyone who can reach it. Reminders and messages are tied to an identity, which in open mode anyone can claim. BAB masks secrets and, by default, email addresses by their shape before it writes. This is best effort, not a guarantee. Most API and tool calls and the main web pages go to an audit log, which is kept 365 days by default (`BAB_AUDIT_RETENTION_DAYS`). The event stream, the API index, the MCP handshake and most hook calls are not audited. The database file has mode 0600. Use volume encryption from your platform. Threat model, hardening checklist and disclosure process: [SECURITY.md](SECURITY.md). Report vulnerabilities through the private GitHub security advisory form. Supported versions: the latest minor release.

## Deploy and operate

- **Configuration**: every setting is an environment variable, listed in [docs/configuration.md](docs/configuration.md) (generated from the code).
- **Docker Compose** quick start and hardening: [docs/deploy/compose.md](docs/deploy/compose.md). **Behind oauth2-proxy**: [docs/deploy/oauth2-proxy.md](docs/deploy/oauth2-proxy.md).
- **Build your own image** and push it to your registry: [docs/build.md](docs/build.md). Any `node:24-alpine` compatible base image works through the `BASE_IMAGE` build argument. There is no published image yet.
- **Runtime shape**: one replica and a local block volume at `/data`. SQLite runs in write-ahead-log (WAL) mode. NFS, SMB and Azure Files are not supported. Health checks are `/healthz` and `/readyz`. BAB shuts down cleanly on SIGTERM and runs as a non-root user. Defaults: `DATA_DIR=/data`, `PORT=3000`, `HOSTNAME=0.0.0.0`.
- **Backups**: BAB keeps a consistent copy at `/data/snapshot.db`, made with SQLite's `VACUUM INTO`. It has mode 0600 like the database. It is refreshed at most every 20 hours while the instance is in use. Point a backup tool at it, running as the same user or as root. Built-in backups are on the roadmap.
- **Upgrades**: migrations run forward on startup. Back up before upgrading.
- **Limits**: 2000 requests a minute per identity, 1000 a minute per address for unknown callers and 3000 process-wide for anonymous MCP. POST endpoints accept an `Idempotency-Key`. Request bodies are capped at 1048576 bytes (`BAB_MAX_BODY_BYTES`), checked from `Content-Length` only.

## Develop

```bash
pnpm install
DATA_DIR=./.data pnpm dev        # http://localhost:4310
pnpm check                       # typecheck, unit tests with a coverage gate, e2e against the built server
```

About 2,000 tests sit behind coverage gates (85 percent of lines and functions, 75 percent of branches). An end-to-end suite boots the standalone server. CI runs `pnpm check`, which includes a vendor-name scan, and a Docker build on every push to main and every pull request. BAB needs Node 24 or newer. Contributions follow Conventional Commits: [CONTRIBUTING.md](CONTRIBUTING.md). Releases are cut by release-please: [CHANGELOG.md](CHANGELOG.md).

## Roadmap

- [ ] Published image on GHCR, so the quick start needs no build
- [ ] Hook adapters for Cursor and Codex. The hook endpoint is plain HTTP, so other harnesses could get the session-start inbox and house rules too
- [ ] A tested client guide: Cursor, Codex, Windsurf, Claude Desktop, Copilot
- [ ] Postgres storage and multi-replica support
- [ ] Plugin hooks sending the bearer token in token mode, and only the fields the server reads
- [ ] Request body cap enforced on chunked uploads, not only on `Content-Length`
- [ ] Token mode hardening on web routes
- [ ] CORS origins setting, JSON log format, built-in backups
- [ ] Pin the container user to UID 1000

Ideas and bugs: [issues](https://github.com/enhesa/big-agentic-brain/issues).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The fonts Inter and Urbanist are under the SIL Open Font License.
