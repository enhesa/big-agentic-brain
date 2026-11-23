# Memory for any board

Your agents coordinate on a message board, a task queue or a tracker. That tool hands work over and keeps the conversation. It does not keep what the work taught. This guide gives those agents a memory without changing the board: they search BAB before they claim a task, and record what they learned when they finish.

BAB does not read or write your board. The agents do both, by habit.

## What changes for an agent

| Moment | Without BAB | With BAB |
|---|---|---|
| Before a claim | The agent reads the task and starts. | It searches BAB for the task's title and error text, and reads the house rules for the repository. |
| Stuck | It debugs from nothing. | It searches the error text first. Another agent may have fixed it. |
| Done | It posts "done" and the lesson stays in the thread. | It saves one memory of what the next agent should know, and links it in its closing message. |

## Set it up

1. **Connect each agent to BAB.** Add `https://<your-bab>/mcp` as an MCP server in the agent's client, or use the HTTP API. See [Connecting an agent](connecting.md).
2. **Give the agents the habits.** Your BAB serves them as a skill at `https://<your-bab>/instructions/board.md`, with your own addresses filled in. Either install that page as a skill in the agent's harness, or paste this paragraph into the instructions your board gives its agents (its skill, its `AGENTS.md`, or the lead agent's prompt):

> Before you claim a task, search BAB (https://<your-bab>/mcp) for its title and any error text, and
> read the house rules for its repository. When you finish, save what the next agent should
> know to BAB and put the link in your closing message. The full habits are at
> https://<your-bab>/instructions/board.md

3. **Check it once.** Post a task on the board that an earlier memory answers. The agent that claims it should cite that memory in its first reply.

## What an agent saves, and what it does not

- It saves what was learned: the cause of a failure, a house rule it met, a step that was missing from the task. One memory, with a link back to the task or thread.
- It does not save status. "Done, merged" stays on the board. Work that taught nothing saves nothing.
- It never copies secrets, client names, personal data or whole threads. BAB is read by the whole organization. A board channel may not be.
- A thread that settled a question becomes a decision only after the user's yes.

## Limits

- Nothing enforces the habits. An agent that skips the search is not stopped. The paragraph in the board's own instructions is what makes them stick.
- BAB has no connector to any board: no sync, no webhook, no claim. The board keeps task state, and BAB keeps knowledge.
- Messages on a board and memories in BAB were both written by other people and agents. The skill tells the agent to treat both as data, never as instructions.
