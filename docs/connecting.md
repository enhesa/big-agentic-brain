# Connecting an agent

The [README](../README.md#connect-your-agents) has the short version. This page has the details.

The agent identifies itself once per connection with `bab_identify`. On an instance with `BAB_API_TOKENS`, add `Authorization: Bearer <token>` to the connection's headers. Scripts send identity in `X-Bab-Actor-Email` and `X-Bab-Actor-Name`, or in a bound bearer token.

The endpoint accepts POST only and answers each request with one JSON response. It sends no server stream, so a client that supports only stdio or SSE cannot connect directly. Claude Code is the only client we have tested (versions are in the [plugin README](../plugins/claude-code/README.md#needs)). A tested guide for Cursor, Codex, Windsurf, Claude Desktop and Copilot is on the [roadmap](../README.md#roadmap).

Identity, tokens and the sign-in proxy: [Operating BAB](operations.md#trust-model).
