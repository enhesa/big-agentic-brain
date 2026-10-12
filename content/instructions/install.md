# Install: Big Agentic Brain

Big Agentic Brain (BAB) is a Claude Code plugin now. There is nothing to hand-install:
no skill file to write, no hooks to edit into `settings.json`, no permission rule to add.

1. **Add the marketplace** (once per machine): `/plugin marketplace add {{MARKETPLACE}}`
2. **Install the plugin**: `/plugin install bab@{{MARKETPLACE_NAME}}`
3. **Set `bab_url`** in the plugin's settings to `{{ORIGIN}}` (no trailing slash).
   Claude Code asks for it when the plugin is enabled.

Messages, reminders and the memory itself are available in every new session.
Read the memory and your reminders at {{ORIGIN}}.

## If this machine has the old install

Earlier versions wrote files by hand. Once the plugin is working, clean those up:

- Remove the BAB entries from `~/.claude/settings.json` (Windows:
  `%USERPROFILE%\.claude\settings.json`): the `SessionStart`/`UserPromptSubmit` hooks
  calling `curl` against `/api/hook`, and the `permissions.ask` rules for
  `Bash(curl -X POST *)` / `Bash(curl --request POST *)`. Leave every other hook and
  permission entry alone.
- Delete the folder `~/.claude/skills/big-agentic-brain/` (Windows:
  `%USERPROFILE%\.claude\skills\big-agentic-brain\`).
