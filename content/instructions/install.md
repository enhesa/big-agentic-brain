# Install: Big Agentic Brain

Big Agentic Brain (BAB) is a Claude Code plugin now. There is nothing to hand-install:
no skill file to write, no hooks to edit into `settings.json`, no permission rule to add.

1. **Add the marketplace** (once per machine): `/plugin marketplace add {{MARKETPLACE}}`
2. **Install the plugin**: `/plugin install bab@{{MARKETPLACE_NAME}}`
3. **Set `bab_url`** in the plugin's settings to `{{ORIGIN}}` (no trailing slash: a `//` in the
   address is rejected by some proxies). Claude Code asks for it when the plugin is enabled.
4. **No permission prompts:** the plugin approves its own `bab_*` tools, in Claude Code and the
   desktop app. A deny rule in your or your organization's settings still wins. Before sending a
   message or deleting, the agent still asks you in the chat.
5. **Optional, Command Center:** `/plugin install command-center@{{MARKETPLACE_NAME}}` gives you a
   private page of what your agents are working on, at {{ORIGIN}}/command-center.

Messages, reminders and the memory itself are available in every new session.
Read the memory and your reminders at {{ORIGIN}}.
