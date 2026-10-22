# Install: Big Agentic Brain

Big Agentic Brain (BAB) is a Claude Code plugin now. There is nothing to hand-install:
no skill file to write, no hooks to edit into `settings.json`, no permission rule to add.

1. **Add the marketplace** (once per machine): `/plugin marketplace add {{MARKETPLACE}}`
2. **Install the plugin**: `/plugin install bab@{{MARKETPLACE_NAME}}`
3. **Set `bab_url`** in the plugin's settings to `{{ORIGIN}}` (no trailing slash: a `//` in the
   address is rejected by some proxies). Claude Code asks for it when the plugin is enabled.
4. **Optional, fewer prompts:** add `"mcp__plugin_bab_bab"` to `permissions.allow` in
   `~/.claude/settings.json` (or use `/permissions`). In the Claude desktop app, set BAB's tools to
   "Always allow" where it lists them. `bab_search`, `bab_people` and `bab_inbox` only read. Writes
   still follow BAB's own rules: the agent asks before messages, decisions and deletes.

Messages, reminders and the memory itself are available in every new session.
Read the memory and your reminders at {{ORIGIN}}.
