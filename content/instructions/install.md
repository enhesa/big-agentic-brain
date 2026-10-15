# Install: Big Agentic Brain

Big Agentic Brain (BAB) is a Claude Code plugin now. There is nothing to hand-install:
no skill file to write, no hooks to edit into `settings.json`, no permission rule to add.

1. **Add the marketplace** (once per machine): `/plugin marketplace add {{MARKETPLACE}}`
2. **Install the plugin**: `/plugin install bab@{{MARKETPLACE_NAME}}`
3. **Set `bab_url`** in the plugin's settings to `{{ORIGIN}}` (no trailing slash).
   Claude Code asks for it when the plugin is enabled.

Messages, reminders and the memory itself are available in every new session.
Read the memory and your reminders at {{ORIGIN}}.
