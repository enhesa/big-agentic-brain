#!/bin/sh
# BAB Tasks Stop hook: at the end of a turn, checks that the turn published to BAB Tasks.
# It blocks the stop once, with a short reason, when the turn since the last real user prompt made
# tool calls and either
#   - none of them was a bab_tasks publish or patch that succeeded (list and export do not
#     count), or
#   - 5 or more tool calls came after the last publish or patch (the card is likely stale).
#     Calls that only report back (thread sends, PR watch, background waits) do not count.
# It passes a turn with no tool calls, a second stop in the same turn (stop_hook_active, so it
# never loops), and BAB_TASKS_STOP_HOOK=off. It stays quiet for the rest of the session once a
# "did not publish" block was answered without any bab_tasks call (the tool is missing or off, or the person asked
# to leave BAB Tasks alone), or once bab_tasks answered that BAB Tasks is switched off.
# Portable: POSIX sh and one awk run, nothing else (no jq, python or node), because every process
# start is slow on Windows. Reads only the local transcript named on stdin; no network call.
# Fails open: on any problem it exits 0 and blocks nothing.

case "${BAB_TASKS_STOP_HOOK:-on}" in
  off|OFF|Off|0|false|no) exit 0 ;;
esac

# awk reads the hook JSON from stdin, then the transcript it names (JSON Lines).
# A quote inside a JSON string is escaped, so an unescaped "key":"value" pattern is always
# structure, never text someone typed.
# Only user and assistant lines count. Lines that start with another type (request copies,
# titles, bookkeeping) are skipped: some hold whole earlier conversations.
# A real user prompt is a user line that is not a tool result, not meta, not a compaction summary,
# not a background task notification and not a side chain; it starts a new turn. Assistant
# tool_use blocks after it are the turn's tool calls. A tool's name is the first "name" after
# "tool_use" and before its input, so a "name" inside the input is never read as the tool.
# Path escapes: \\ and \/ are decoded. A \uXXXX escape is not; Claude Code does not write one,
# and a wrong path only means the file is not found, which passes.
verdict=$(awk '
  function toolname(s) {
    if (!match(s, /"type": *"tool_use"[^{}]*"name": *"[^"]*"/)) return ""
    s = substr(s, RSTART, RLENGTH)
    sub(/.*"name": *"/, "", s)
    sub(/"$/, "", s)
    return s
  }
  function toolid(s) {
    if (!match(s, /"type": *"tool_use"[^{}]*"id": *"[^"]*"/)) return ""
    s = substr(s, RSTART, RLENGTH)
    sub(/.*"id": *"/, "", s)
    sub(/"$/, "", s)
    return s
  }
  { input = input $0 "\n" }
  END {
    # Never block twice in a row: Claude Code sets this when the agent already continues
    # because of a Stop hook.
    if (input ~ /"stop_hook_active"[ \t\r\n]*:[ \t\r\n]*true/) { print "pass"; exit }
    if (!match(input, /"transcript_path"[ \t\r\n]*:[ \t\r\n]*"([^"\\]|\\.)*"/)) { print "pass"; exit }
    raw = substr(input, RSTART, RLENGTH)
    sub(/^"transcript_path"[ \t\r\n]*:[ \t\r\n]*"/, "", raw)
    raw = substr(raw, 1, length(raw) - 1)
    path = ""
    n = length(raw)
    for (i = 1; i <= n; i++) {
      c = substr(raw, i, 1)
      if (c == "\\" && i < n) { i++; c = substr(raw, i, 1) }
      path = path c
    }
    if (path == "") { print "pass"; exit }

    tools = 0; published = 0; after = 0; turn = 0
    quiet = 0; blocked = 0; answered = 0
    while ((status = (getline line < path)) > 0) {
      if (line ~ /^\{"type": *"/ && line !~ /^\{"type": *"(user|assistant)"/) continue
      if (line ~ /"isSidechain": *true/) continue
      if (line ~ /"type": *"user"/ && line ~ /"role": *"user"/) {
        if (line ~ /"type": *"tool_result"/) {
          if (match(line, /"tool_use_id": *"[^"]*"/)) {
            id = substr(line, RSTART, RLENGTH)
            sub(/.*"tool_use_id": *"/, "", id); sub(/"$/, "", id)
            # bab_tasks answered that BAB Tasks is switched off on this BAB.
            if (id in taskids && line ~ /BAB Tasks is switched off/) quiet = 1
            # A publish or patch that failed did not publish: undo it, and count it as a call.
            if ((id in pubturn) && pubturn[id] == turn && line ~ /"is_error": *true/) {
              published = prevpub[id]; after = prevafter[id] + after + 1
            }
          }
          continue
        }
        if (line ~ /"isMeta": *true/) {
          # Our own "did not publish" block, fed back to the agent. Remember it to see how the
          # agent answers. The stale reminder is not remembered: ignoring it silences nothing.
          if (line ~ /Stop hook feedback/ && line ~ /BAB Tasks: / && line ~ /did not publish/) { blocked = 1; answered = 0 }
          continue
        }
        if (line ~ /"isCompactSummary": *true/) continue
        if (line ~ /"origin": *\{"kind": *"task-notification"/) continue
        # A new turn. A block the agent answered without any bab_tasks call means it cannot or
        # must not publish in this session: stay quiet from here on.
        if (blocked && !answered) quiet = 1
        blocked = 0
        turn++
        tools = 0; published = 0; after = 0
        continue
      }
      if (line ~ /"role": *"assistant"/ && line ~ /"type": *"tool_use"/) {
        name = toolname(line)
        tools++
        if (name ~ /bab_tasks$/) {
          answered = 1
          id = toolid(line)
          if (id != "") taskids[id] = 1
          if (line ~ /"action": *"(publish|patch)"/) {
            if (id != "") { pubturn[id] = turn; prevpub[id] = published; prevafter[id] = after }
            published++; after = 0
          }
        } else if (name !~ /(t3_thread_send|watch_pull_request|link_pull_requests?|t3_background_wait|send_to_user|TaskStop)$/) {
          after++
        }
      }
    }
    close(path)
    # This stop is not the one right after our block (stop_hook_active passed that one), so a
    # block still unanswered by any bab_tasks call was declined, even when no new prompt came
    # yet (a background task notification wakes the agent without one).
    if (blocked && !answered) quiet = 1
    if (status < 0 || quiet || tools == 0) { print "pass"; exit }
    if (published == 0) print "block"
    else if (after >= 5) print "stale"
    else print "pass"
  }
' 2>/dev/null) || exit 0

case "$verdict" in
  block)
    printf '%s\n' '{"decision":"block","reason":"BAB Tasks: this turn made tool calls but did not publish to BAB Tasks. Publish or patch your initiative now with bab_tasks: every remaining step as a task, every open question under questions, and a worked line. If the person asked you to leave BAB Tasks alone, or the bab_tasks tool is not available, say so in one line and stop; this hook then stays quiet for the session. Then repeat your full answer after the publish, so it is the last text the person sees; never point back to an earlier message."}'
    ;;
  stale)
    printf '%s\n' '{"decision":"block","reason":"BAB Tasks: you published early in this turn but kept working. Patch your initiative now with bab_tasks so it shows where things stand: task statuses, remaining steps, open questions, and a worked line. Then repeat your full answer after the publish, so it is the last text the person sees; never point back to an earlier message."}'
    ;;
esac
exit 0
