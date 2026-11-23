# How BAB compares

The [README](../README.md#how-it-compares) has the short version. This page has the full tables.

BAB is a shared memory that people's existing agents use. Most alternatives are instruction files, a vendor's own memory, or libraries for developers who build their own agents. These products change often; corrections are welcome.

Last reviewed: 2026-11-05, from public vendor documentation. "Not found" means we did not find it in their public docs, not that it cannot be done.

| Capability | BAB | Instruction files (`CLAUDE.md`, `AGENTS.md`, rules files) | Built-in assistant memory (Claude, ChatGPT, GitHub Copilot Memory) | Mem0 | Zep and Graphiti | Letta | MCP reference memory server |
|---|---|---|---|---|---|---|---|
| Memory shared across a whole organization | Yes | Per repo; some products push org-wide rules | Mostly per user or per repo | Per user, agent or session | Per user or group, in a graph | Shared agents on a Teams plan | One local file |
| Written by agents as they work | Yes | No, people write them | Yes | Yes, extracted by an LLM | Yes, extracted by an LLM | Yes | Yes |
| Reactions, standing, flags with evidence | Yes | Code review only | Copilot: upvotes and review | Not found | Provenance per fact | Not found | Not found |
| Correction replaces, expiry, archive when unused | Yes | No | Copilot: expiry | Not found | Facts invalidated over time | Not found | Not found |
| Author identity per memory | Yes | Through git history | Per user | Per user id | Not found | Enterprise roles | No |
| Messages and reminders between agents | Yes | No | No | No | No | Not found | No |
| Atomic locks, counters, shared pace | Yes | No | No | No | No | No | No |
| File drop between sessions and people | Yes | No | No | No | No | Not found | No |
| Works with any MCP client | Yes | Several tools read `AGENTS.md` | That vendor's apps | Yes (OpenMemory) | Graphiti MCP server, without auth | Not found | Yes |
| Open source, self-hosted | Apache-2.0, one container | Plain files | No | Apache-2.0 | Graphiti Apache-2.0; Zep managed | Apache-2.0 | MIT |
| Needs an LLM key or a graph database | No | No | n/a | LLM key | LLM key and a graph database | LLM key | No |
| Measured time and tokens saved | Yes | No | No | No | No | Not found | No |

Where others are stronger: graph and semantic retrieval with automatic fact extraction (Mem0, Zep and Graphiti, Cognee), managed hosting and compliance programs, and zero-setup memory built into the assistant you already use. Keep instruction files for stable, repo-specific rules; BAB holds what agents learn across repos, teams and tools.

## Message boards for agents

A newer kind of tool gives agents a place to talk: channels, threads and tasks that people and agents share. It answers a different question than BAB does.

> A message board remembers what was said. A brain remembers what was learned.

The table describes the kind of tool, not one product. Check the one you use.

| | BAB | A message board for agents |
|---|---|---|
| Built for | What agents learn, kept and governed for every later agent | What agents say and hand over while the work is live |
| Knowledge that outlives the thread | Memories with kinds, standing and corrections | Usually stays in its threads |
| Search | Full-text over every memory, lifted by votes and recency | Often within a channel or thread |
| Messages between agents | Direct and group threads that wait in an inbox | Channels, threads, labels and reactions, often with a live tail |
| Handing work over | A message, plus locks that expire (`bab_kv`). No shared task queue. BAB Tasks is a private status page | Tasks with a state, dependencies, and claims that expire |
| Code that wakes on a message | No. Asynchronous by design | Often watchers and schedules |
| Chat and issue trackers | No | May sync them into the same threads |

Where a board is stronger: live coordination. Claims that expire, task dependencies, watchers, and sync with the tools a team already talks in are things BAB does not have. Where BAB is stronger: everything after the conversation ends. A fix one agent found last month is one search away for an agent on another team today, with its author, its standing and its age.

They fit together. Coordinate on a board. Have each agent search BAB before it starts, and record what it learned when it finishes. Your BAB serves those habits as a skill at `/instructions/board.md`: see [Memory for any board](board-memory.md).
