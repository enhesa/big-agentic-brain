#!/bin/sh
# BAB Tasks Stop hook: at the end of a turn, checks that the turn published to BAB Tasks.
# If the turn since the last real user prompt made at least one tool call and none of them was a
# bab_tasks call, it blocks the stop once, with a short reason that asks the agent to publish.
# A turn with no tool calls passes. A second stop in the same turn (stop_hook_active) passes, so it
# never loops. BAB_TASKS_STOP_HOOK=off turns it off.
# Portable: POSIX sh and one awk run, nothing else (no jq, python or node), because every process
# start is slow on Windows. Reads only the local transcript named on stdin; no network call.
# Fails open: on any problem it exits 0 and blocks nothing.

case "${BAB_TASKS_STOP_HOOK:-on}" in
  off|OFF|Off|0|false|no) exit 0 ;;
esac

# Read the hook JSON with shell builtins only.
input=
while IFS= read -r line || [ -n "$line" ]; do
  input="$input$line"
done
[ -n "$input" ] || exit 0

# Never block twice in a row: Claude Code sets this when the agent already continues
# because of a Stop hook.
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) exit 0 ;;
esac

# The raw JSON string after "transcript_path". awk undoes its escapes.
case "$input" in
  *'"transcript_path"'*) ;;
  *) exit 0 ;;
esac
raw=${input#*\"transcript_path\"}
raw=${raw#*\"}
raw=${raw%%\"*}
[ -n "$raw" ] || exit 0

# Walk the transcript (JSON Lines). A quote inside a JSON string is escaped, so an unescaped
# "key":"value" pattern is always structure, never text someone typed.
# Only user and assistant lines count. Lines that start with another type (request copies,
# titles, bookkeeping) are skipped: some hold whole earlier conversations.
# A real user prompt is a user line that is not a tool result, not meta, not a compaction summary
# and not a side chain; it starts a new turn. Assistant tool_use blocks after it are the turn's
# tool calls.
verdict=$(BAB_TASKS_TRANSCRIPT="$raw" awk '
  BEGIN {
    raw = ENVIRON["BAB_TASKS_TRANSCRIPT"]; path = ""
    for (i = 1; i <= length(raw); i++) {
      c = substr(raw, i, 1)
      if (c == "\\" && i < length(raw)) { i++; c = substr(raw, i, 1) }
      path = path c
    }
    tools = 0; tasks = 0
    while ((status = (getline line < path)) > 0) {
      if (line ~ /^\{"type": *"/ && line !~ /^\{"type": *"(user|assistant)"/) continue
      if (line ~ /"isSidechain": *true/) continue
      if (line ~ /"type": *"user"/ && line ~ /"role": *"user"/) {
        if (line ~ /"type": *"tool_result"/) continue
        if (line ~ /"isMeta": *true/) continue
        if (line ~ /"isCompactSummary": *true/) continue
        tools = 0; tasks = 0
        continue
      }
      if (line ~ /"role": *"assistant"/ && line ~ /"type": *"tool_use"/) {
        tools++
        if (line ~ /"name": *"[^"]*bab_tasks"/) tasks++
      }
    }
    if (status < 0) { print "pass"; exit }
    if (tools > 0 && tasks == 0) print "block"; else print "pass"
  }
' 2>/dev/null) || exit 0

[ "$verdict" = "block" ] || exit 0

printf '%s\n' '{"decision":"block","reason":"BAB Tasks: this turn made tool calls but did not publish to BAB Tasks. Publish or patch your initiative now with bab_tasks, with every remaining step as a task, every open question in questions, and a worked line. If the person asked you to leave BAB Tasks alone, or the bab_tasks tool is not available, say so in one line and stop."}'
exit 0
