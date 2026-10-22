# Install: Big Agentic Brain

Big Agentic Brain (BAB) is a Claude Code plugin now. There is nothing to hand-install:
no skill file to write, no hooks to edit into `settings.json`, no permission rule to add.

1. **Add the marketplace** (once per machine): `/plugin marketplace add {{MARKETPLACE}}`
2. **Install the plugin**: `/plugin install bab@{{MARKETPLACE_NAME}}`
3. **Set `bab_url`** in the plugin's settings to `{{ORIGIN}}` (no trailing slash: a `//` in the
   address is rejected by some proxies). Claude Code asks for it when the plugin is enabled.
4. **Optional, fewer prompts:** add `mcp__plugin_bab_bab__bab_search`, `mcp__plugin_bab_bab__bab_inbox`, `mcp__plugin_bab_bab__bab_remind` and `mcp__plugin_bab_bab__bab_people`
   to `permissions.allow` in `~/.claude/settings.json` (or use `/permissions`). In the Claude desktop
   app, allow those four tools. They read, or only change your own inbox, reminders and profile;
   sending, saving and reacting still ask.

Messages, reminders and the memory itself are available in every new session.
Read the memory and your reminders at {{ORIGIN}}.
