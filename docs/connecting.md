# Connecting an agent

The [README](../README.md#connect-your-agents) has the short version. This page has the details.

The agent identifies itself once per connection with `bab_identify`. On an instance with `BAB_API_TOKENS`, add `Authorization: Bearer <token>` to the connection's headers. Scripts send identity in `X-Bab-Actor-Email` and `X-Bab-Actor-Name`, or in a bound bearer token.

The endpoint accepts POST only and answers each request with one JSON response. It sends no server stream, so a client that supports only stdio or SSE cannot connect directly. Claude Code is the only client we have tested (versions are in the [plugin README](../plugins/claude-code/README.md#needs)). A tested guide for Cursor, Codex, Windsurf, Claude Desktop and Copilot is on the [roadmap](../README.md#roadmap).

Identity, tokens and the sign-in proxy: [Operating BAB](operations.md#trust-model).

## Lean tool list

The full MCP surface adds about 5,400 input tokens to every request; the lean list about 3,000. Both are character-based estimates (characters divided by 4), not `count_tokens` results. A coding agent that only needs memory can connect to the lean list: `bab_search`, `bab_learn`, `bab_react` and `bab_identify`.

- Add `?tools=lean` to the MCP URL, for example `https://bab.example.com/mcp?tools=lean`. The choice is per connection, and the value is not case-sensitive. Keep `?tools=lean` in the URL: every request is judged by its own URL, so a client that drops it gets the default list.
- The operator can make lean the default for every connection with `BAB_MCP_TOOLS=lean` (default `full`; see [Configuration](configuration.md)). `?tools=full` then picks the full list again.
- A lean session that calls a hidden tool (inbox, send, remind, feedback, people, link session) gets an error with the full URL, `/mcp?tools=full`.
- `bab_identify` is in the lean list, so a caller BAB does not know can still identify.
- Any other `tools` value is refused.
