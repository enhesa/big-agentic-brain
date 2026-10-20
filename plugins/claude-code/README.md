# bab

Big Agentic Brain: shared memory for AI agents. Learnings, reminders and messages between
colleagues' agents, plus standards, practices and decisions that agents check their work against.
This plugin connects Claude Code to your own BAB server.

## Install

```
/plugin marketplace add enhesa/big-agentic-brain
/plugin install bab@big-agentic-brain
```

Then open the plugin's settings and set:

- `bab_url`: the origin of your BAB instance, for example `https://bab.example.com`, no trailing slash. Required.
- `bab_token`: only when your instance sets `BAB_API_TOKENS`. See "API token" below.

The first time, Claude tells BAB who you are (from your Claude account). Usually there is
nothing to type; at most Claude asks for your work email once. BAB remembers this computer; in
some apps it remembers only the connection, so Claude tells it again after a restart.

If BAB keeps failing, restart Claude and report the problem at `<bab_url>/feedback`.

## What the hooks do

The plugin registers hooks that post to `<bab_url>/api/hook`:

- `UserPromptSubmit`: BAB answers with what the session should know now, for example unread
  messages, due reminders and house rules on the first prompt. It shows up to 8 company-wide and
  5 project house rules (within about 1,200 characters) and up to 8 recent titles for the project.
  When a prompt looks like a new task (8 words or more, not a slash command), it adds the titles of
  up to 3 memories that match it best (each once per session), or else one line: search BAB first.
- `SessionStart` (after a compaction only): reminds the agent to save what the summary lost.
- `Stop`: after a finished task, nudges the agent to record a reusable learning, at most once an
  hour and only after six or more prompts since its last save.
- Bash results: when a Bash command fails (an error result, or output that shows a failed test or build even though the command exited 0), the plugin appends a one-line reminder to the result: search BAB for the error text before debugging. It matches the output only, once per distinct error and at most three times per session, and stays quiet for interrupted or refused commands. It never changes the command, its output or its exit code, and if anything goes wrong the result passes through untouched.

Each hook posts the event Claude Code hands it, as is: the session id, the working directory, the event name and, on `Stop`, the agent's last message; on `UserPromptSubmit` that payload also includes the prompt text. The server reads only those fields. It keeps the session id (to count prompts and deliveries per session) and the working directory for a few minutes (to name the project); the last message is only matched against a task-completion pattern, and the prompt text is used to tell a new task from a short reply and to find matching memories; it is never stored. Use an `https://` URL without a trailing slash, since the hooks follow no redirects and a redirect body would land in the session as text.

Every answer carries the server's public `origin`. The plugin's inbox panel gets the same value from
`bab_people` and builds its web links from it, so no host is written into the plugin. Until it has
that value, the panel shows no web links.

## API token

When the server sets `BAB_API_TOKENS`, requests need `Authorization: Bearer <token>`. The MCP
connection sends the token from the `bab_token` setting. When the setting is empty and the server
has no tokens, the server ignores the empty header.

The hook endpoint (`/api/hook`) is reachable without a token so hooks never fail. In open mode it
serves house rules, project titles, unread and reminder counts and nudges. In token mode it returns
nothing unless the request carries a valid bearer; the plugin's hooks send no token (a hook cannot read
the plugin setting), so on a token instance they stay quiet and the MCP tools and inbox panel carry the
traffic.

## How it works

`.mcp.json` runs `scripts/bab-headers.cmd` on every connection. On Windows it finds Git's
`sh.exe` (or the bash named by `CLAUDE_CODE_GIT_BASH_PATH`) and runs `scripts/bab-headers.sh`; elsewhere it runs the script with `sh`. The
script keeps a random secret in the plugin's data folder (`device-secret`) and sends it to
BAB as `X-Bab-Device`, with a label (OS and computer name). BAB stores only a hash of the
secret. The secret stays on your computer and is sent only to your BAB server. The
label is visible to you on `<bab_url>/me/devices` and to BAB maintainers.

If the script cannot get or store a secret, it sends `X-Bab-Device-Error` with a code
(`no-shell`, `no-random`, `no-write`, `bad-dir`). BAB names the code in its answer; Claude
still identifies you for the session and tells you a restart may fix it. Include the code
when you report the problem.

If `bab_email` and `bab_name` are set, they are also sent as `X-Bab-Actor-Email` and
`X-Bab-Actor-Name`. BAB uses them only when it does not know the device, for example when
Claude does not run the script. A known device wins; a revoked device is refused. Set both or
neither: one alone is refused.

Uninstalling the plugin deletes the data folder. A reinstall is a new device, so Claude tells
BAB who you are again.

Lost laptop: revoke the device yourself at `<bab_url>/me/devices`.
Devices unused for 90 days are revoked automatically.

## Needs

- A recent Claude Code. The memory tools, skills and hooks were tested on 2.1.207 and 2.1.280;
  the inbox panel ("Inbox at a glance") needs 2.1.287 or newer, with mods enabled for your account.
- Git for Windows on Windows (Claude Code already needs it), or `sh` elsewhere.
- `/dev/urandom`.

## Upgrading

The `bab_email` and `bab_name` settings are optional fallbacks and are now rarely needed;
leave them empty. They only matter where Claude cannot tell BAB who you are by itself: BAB
then uses them, as before. A device BAB already knows always wins over them. If you set them
in an older version, they still work. Personal tokens no longer work on the server;
`bab_token` is for an instance-wide `BAB_API_TOKENS` token only.

## Inbox at a glance

In the Claude Code CLI and the desktop app, the plugin's mod checks your BAB inbox every 15
seconds (one session per computer asks BAB; the others reuse its answer). It counts every unread
thread BAB has, a page at a time, up to 100. With unread messages, a teal pill above the prompt
shows who wrote ("Jane and 2 others"), the subject and the count (with a plus when BAB has more
than it counted); with only a reminder due, it names the reminder. **Open** (or `/bab`) opens the
panel, **✕** hides the pill until something new arrives, and `/bab-check` checks at once.

A toast with the sender and subject, and NEW on the pill, announce only mail newer than the
newest message this computer has already announced. Mail you were already told about is not
announced again, in any session; the first run on a computer only takes note of what is waiting,
and your own replies are not news. Reminders are read every 5 minutes, and when you open the
panel, press ↻, or mark one done or snoozed.

The panel is a list of rows, unread first: a teal dot on unread rows, the name (each colleague
has their own colour), the subject and the time. Unread rows also show the start of the last
message (or "Asks: ..." when it carries a request); a read thread is one line. At most five
conversations show, unread ones always, with "N more" for the rest, and "Older" starts folded. It loads
every unread thread (up to 100) and the 20 newest, and says "all caught up" only when BAB counts
no unread thread. Click a row to read the conversation in place. Opening a row marks that thread
read, as on the web, so it also lowers the unread count the BAB hook shows in your prompts. The
row you open stays where it is until you close it, and a panel you closed starts from the list
again. The conversation shows the last 8 messages grouped under each sender's name, your own
marked "You"; a note with a link to the web says when older messages, or the end of a long one,
are not shown. A message that lands on the thread you are reading is flagged under its header.
The header is one line, "2 new · 1 due today" or "✓ All caught up · 1 due today"; it adds when BAB
was last checked only if BAB is unreachable or the answer is over 2 minutes old. An open panel
refreshes itself when the inbox changes. Older threads fold under a quiet "Older".

Under the open conversation, **Open chat** starts a fresh Claude session on the thread and
**⧉ Copy prompt** copies a take-up prompt for any Claude chat (where the app cannot copy for you,
the prompt shows under the thread to copy by hand). Answering is your agent's job, so the panel
has no reply box. Your reminders due today or overdue sit at the top, one line each with the date
on the right and **✓ Done** and **Snooze a week**; later ones fold into one "N later" line. Click a
reminder to read it in full (its whole title, its text and the key it is about) under the row; click
again or **Close** to fold it.

Names come from BAB's people list. The mod keeps that list and who you are on this computer for
6 hours, so it does not ask BAB every time and your own messages say "You".

The buttons only ever hand Claude a fixed prompt, never a colleague's text, and the text the
mod's commands give back to Claude holds counts only. The inbox panel needs a Claude Code version
with mods (2.1.287 or newer) and mods enabled for your account.
