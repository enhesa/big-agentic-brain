#!/bin/sh
# Tests for scripts/tasks-stop.sh, the BAB Tasks Stop hook. POSIX sh, no other tools needed.
# Run: sh plugins/bab-tasks/test/run.sh   (Git Bash on Windows, macOS, Linux). Exits 1 on a failure.

here=$(cd "$(dirname "$0")" && pwd)
hook="$here/../scripts/tasks-stop.sh"
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t babtasks)
trap 'rm -rf "$tmp"' EXIT
fails=0
count=0

# Transcript lines in the shape Claude Code writes them.
prompt() { printf '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"%s"},"uuid":"u%s"}\n' "$1" "$2"; }
meta() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"text","text":"skill text"}]},"isMeta":true,"uuid":"m1"}\n'; }
tool() { printf '{"parentUuid":"a","isSidechain":false,"message":{"model":"m","id":"msg","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_%s","name":"%s","input":{"action":"%s","x":"y"}}]},"type":"assistant","uuid":"t%s"}\n' "$2" "$1" "${3:-patch}" "$2"; }
feedback() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":"Stop hook feedback:\\nBAB Tasks: this turn made tool calls but did not publish."},"isMeta":true,"uuid":"f1"}\n'; }
result_off() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_%s","type":"tool_result","content":"BAB Tasks is switched off on this BAB","is_error":true}]},"uuid":"r%s"}\n' "$1" "$1"; }
result() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_%s","type":"tool_result","content":"ok"}]},"uuid":"r%s"}\n' "$1" "$1"; }
say() { printf '{"parentUuid":"a","isSidechain":false,"message":{"model":"m","id":"msg","type":"message","role":"assistant","content":[{"type":"text","text":"%s"}]},"type":"assistant","uuid":"s1"}\n' "$1"; }
side() { printf '{"parentUuid":"a","isSidechain":true,"type":"user","message":{"role":"user","content":"subagent prompt"},"uuid":"x1"}\n'; }
blob() { printf '{"type":"api-request-blob","sessionId":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_b","name":"Bash","input":{}}]}}\n'; }
result_err() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_%s","type":"tool_result","content":"tasks[3].text is too long","is_error":true}]},"uuid":"r%s"}\n' "$1" "$1"; }
stale_feedback() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":"Stop hook feedback:\\nBAB Tasks: you published early in this turn but kept working."},"isMeta":true,"uuid":"f2"}\n'; }
notify() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":"task finished"},"origin":{"kind":"task-notification"},"uuid":"n1"}\n'; }
image() { printf '{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","data":"AAAA"}}]},"uuid":"i1"}\n'; }
compact() { printf '{"parentUuid":"a","isSidechain":false,"type":"user","message":{"role":"user","content":"summary"},"isCompactSummary":true,"uuid":"c1"}\n'; }

stdin_for() { printf '{"session_id":"s","transcript_path":"%s","hook_event_name":"Stop","stop_hook_active":%s}' "$1" "${2:-false}"; }

# expect <name> <block|stale|pass> <stdin> [env assignment]
expect() {
  count=$((count + 1))
  if [ -n "$4" ]; then
    out=$(printf '%s' "$3" | env "$4" sh "$hook"); code=$?
  else
    out=$(printf '%s' "$3" | sh "$hook"); code=$?
  fi
  got=pass
  case "$out" in *'kept working'*) got=stale ;; *'"decision":"block"'*) got=block ;; esac
  if [ "$code" -ne 0 ]; then
    echo "FAIL $1: exit $code"; fails=$((fails + 1))
  elif [ "$2" != pass ] && case "$out" in *'Then repeat your full answer after the publish, so it is the last text the person sees; never point back to an earlier message."}') false ;; *) true ;; esac; then
    echo "FAIL $1: a block reason must end with the repeat-answer sentence, got: $out"; fails=$((fails + 1))
  elif [ "$got" != "$2" ]; then
    echo "FAIL $1: expected $2, got $got ($out)"; fails=$((fails + 1))
  elif [ "$got" = pass ] && [ -n "$out" ]; then
    echo "FAIL $1: a pass must print nothing, got: $out"; fails=$((fails + 1))
  else
    echo "ok   $1"
  fi
}

t="$tmp/no-tasks.jsonl"
{ prompt "fix the bug" 1; tool Bash 1; result 1; say "done"; } > "$t"
expect "tools without bab_tasks block" block "$(stdin_for "$t")"

t="$tmp/with-tasks.jsonl"
{ prompt "fix the bug" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; tool Edit 2; result 2; say "done"; } > "$t"
expect "a bab_tasks call passes" pass "$(stdin_for "$t")"

t="$tmp/other-server.jsonl"
{ prompt "fix it" 1; tool Read 1; result 1; tool mcp__acme__bab_tasks 2; result 2; } > "$t"
expect "any tool name ending in bab_tasks passes" pass "$(stdin_for "$t")"

t="$tmp/chat.jsonl"
{ prompt "what is BAB" 1; say "a shared memory"; } > "$t"
expect "a turn with no tool calls passes" pass "$(stdin_for "$t")"

t="$tmp/old-turn.jsonl"
{ prompt "first" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; prompt "second" 2; tool Bash 2; result 2; } > "$t"
expect "bab_tasks in an earlier turn does not count" block "$(stdin_for "$t")"

t="$tmp/chat-after-work.jsonl"
{ prompt "first" 1; tool Bash 1; result 1; prompt "thanks" 2; say "welcome"; } > "$t"
expect "only the current turn counts" pass "$(stdin_for "$t")"

t="$tmp/not-prompts.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; meta; blob; side; tool Bash 2; result 2; } > "$t"
expect "tool results, meta, request copies and side chains are not prompts" pass "$(stdin_for "$t")"

t="$tmp/compacted.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; compact; tool Bash 2; result 2; } > "$t"
expect "a compaction summary is not a prompt" pass "$(stdin_for "$t")"

t="$tmp/no-tasks.jsonl"
expect "stop_hook_active passes" pass "$(stdin_for "$t" true)"
expect "stop_hook_active with spaces passes" pass "{\"transcript_path\": \"$t\", \"stop_hook_active\" : true}"
expect "stop_hook_active false still checks" block "{\"transcript_path\" : \"$t\", \"stop_hook_active\": false}"
expect "stop_hook_active on its own line passes" pass "{\"transcript_path\":\"$t\",
\"stop_hook_active\":
true}"
expect "BAB_TASKS_STOP_HOOK=off passes" pass "$(stdin_for "$t")" BAB_TASKS_STOP_HOOK=off

escaped=$(printf '%s' "$t" | sed 's|/|\\/|g')
expect "an escaped path is read" block "$(stdin_for "$escaped")"

# On Windows Claude Code sends a drive path with escaped backslashes.
if command -v cygpath >/dev/null 2>&1; then
  win=$(cygpath -w "$t" | sed 's|\\|\\\\|g')
  expect "a Windows path is read" block "$(stdin_for "$win")"
fi

expect "empty input passes" pass ""
expect "input that is not JSON passes" pass "not json at all"
expect "no transcript_path passes" pass '{"stop_hook_active":false}'
expect "a missing transcript passes" pass "$(stdin_for "$tmp/missing.jsonl")"

t="$tmp/blob-chat.jsonl"
{ prompt "go" 1; tool Bash 1; result 1; prompt "thanks" 2; blob; say "welcome"; } > "$t"
expect "a request copy holding tool calls does not count" pass "$(stdin_for "$t")"

t="$tmp/notified.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; notify; tool Read 2; result 2; } > "$t"
expect "a background task notification is not a prompt" pass "$(stdin_for "$t")"

t="$tmp/image.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; image; tool Read 2; result 2; } > "$t"
expect "an image-only prompt starts a turn" block "$(stdin_for "$t")"

t="$tmp/not-ending.jsonl"
{ prompt "go" 1; tool bab_tasks_helper 1; result 1; } > "$t"
expect "a name that only contains bab_tasks does not count" block "$(stdin_for "$t")"

mkdir -p "$tmp/dir with (parens)"
t="$tmp/dir with (parens)/x.jsonl"
{ prompt "go" 1; tool Bash 1; result 1; } > "$t"
expect "a path with spaces and parentheses is read" block "$(stdin_for "$t")"

t="$tmp/long-line.jsonl"
long=x; i=0; while [ $i -lt 17 ]; do long="$long$long"; i=$((i + 1)); done
{ prompt "$long" 1; tool Bash 1; result 1; } > "$t"
expect "a very long line is read" block "$(stdin_for "$t")"

t="$tmp/list-only.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1 list; result 1; tool Bash 2; result 2; } > "$t"
expect "a bab_tasks list does not count as publishing" block "$(stdin_for "$t")"

t="$tmp/export-only.jsonl"
{ prompt "go" 1; tool Bash 1; result 1; tool mcp__plugin_bab_bab__bab_tasks 2 export; result 2; } > "$t"
expect "a bab_tasks export does not count as publishing" block "$(stdin_for "$t")"

t="$tmp/publish.jsonl"
{ prompt "go" 1; tool Bash 1; result 1; tool mcp__plugin_bab_bab__bab_tasks 2 publish; result 2; } > "$t"
expect "a bab_tasks publish passes" pass "$(stdin_for "$t")"

t="$tmp/name-in-input.jsonl"
{ prompt "go" 1; printf '{"parentUuid":"a","isSidechain":false,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"name":"x_bab_tasks","action":"patch"}}]},"type":"assistant","uuid":"t1"}\n'; result 1; } > "$t"
expect "a name inside the input is not the tool name" block "$(stdin_for "$t")"

t="$tmp/stale.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; i=2; while [ $i -le 6 ]; do tool Bash $i; result $i; i=$((i + 1)); done; } > "$t"
expect "5 tool calls after the last publish are stale" stale "$(stdin_for "$t")"

t="$tmp/nearly-stale.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; i=2; while [ $i -le 5 ]; do tool Bash $i; result $i; i=$((i + 1)); done; } > "$t"
expect "4 tool calls after the last publish pass" pass "$(stdin_for "$t")"

t="$tmp/republished.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; i=2; while [ $i -le 7 ]; do tool Edit $i; result $i; i=$((i + 1)); done; tool mcp__plugin_bab_bab__bab_tasks 8; result 8; } > "$t"
expect "a later publish resets the stale count" pass "$(stdin_for "$t")"

t="$tmp/reporting.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; for n in mcp__t3-code__t3_thread_send mcp__t3-code__watch_pull_request mcp__t3-code__unwatch_pull_request mcp__t3-code__link_pull_request mcp__t3-code__t3_background_wait TaskStop; do tool "$n" 2; result 2; done; } > "$t"
expect "reporting calls after the last publish do not count" pass "$(stdin_for "$t")"

t="$tmp/stale-list.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; i=2; while [ $i -le 6 ]; do tool Bash $i; result $i; i=$((i + 1)); done; tool mcp__plugin_bab_bab__bab_tasks 7 list; result 7; } > "$t"
expect "a list after the work does not refresh the card" stale "$(stdin_for "$t")"

t="$tmp/declined.jsonl"
{ prompt "first" 1; tool Bash 1; result 1; feedback; say "bab_tasks is not available"; prompt "second" 2; tool Bash 2; result 2; } > "$t"
expect "a block answered without bab_tasks keeps the session quiet" pass "$(stdin_for "$t")"
{ cat "$t"; prompt "third" 3; tool Edit 3; result 3; } > "$t.2"
expect "the session stays quiet in later turns" pass "$(stdin_for "$t.2")"

t="$tmp/answered.jsonl"
{ prompt "first" 1; tool Bash 1; result 1; feedback; tool mcp__plugin_bab_bab__bab_tasks 2; result 2; prompt "second" 3; tool Bash 3; result 3; } > "$t"
expect "a block answered with a publish keeps the hook on" block "$(stdin_for "$t")"

t="$tmp/switched-off.jsonl"
{ prompt "first" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result_off 1; prompt "second" 2; tool Bash 2; result 2; } > "$t"
expect "BAB Tasks switched off keeps the session quiet" pass "$(stdin_for "$t")"

t="$tmp/off-text-elsewhere.jsonl"
{ prompt "first" 1; tool Read 1; result_off 1; prompt "second" 2; tool Bash 2; result 2; } > "$t"
expect "the off text in another tool's result does not count" block "$(stdin_for "$t")"

t="$tmp/declined-then-notified.jsonl"
{ prompt "first" 1; tool Bash 1; result 1; feedback; say "bab_tasks is not available"; notify; tool Read 2; result 2; } > "$t"
expect "a declined block stays quiet after a task notification" pass "$(stdin_for "$t")"

t="$tmp/failed-patch.jsonl"
{ prompt "go" 1; tool Bash 1; result 1; tool mcp__plugin_bab_bab__bab_tasks 2; result_err 2; } > "$t"
expect "a failed patch does not count as publishing" block "$(stdin_for "$t")"

t="$tmp/failed-late-patch.jsonl"
{ prompt "go" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; i=2; while [ $i -le 6 ]; do tool Bash $i; result $i; i=$((i + 1)); done; tool mcp__plugin_bab_bab__bab_tasks 7; result_err 7; } > "$t"
expect "a failed late patch leaves the card stale" stale "$(stdin_for "$t")"

t="$tmp/retried-patch.jsonl"
{ prompt "go" 1; tool Bash 1; result 1; tool mcp__plugin_bab_bab__bab_tasks 2; result_err 2; tool mcp__plugin_bab_bab__bab_tasks 3; result 3; } > "$t"
expect "a retried patch that works counts" pass "$(stdin_for "$t")"

t="$tmp/stale-ignored.jsonl"
{ prompt "first" 1; tool mcp__plugin_bab_bab__bab_tasks 1; result 1; tool Bash 2; result 2; stale_feedback; say "the card is current"; prompt "second" 3; tool Bash 3; result 3; } > "$t"
expect "an ignored stale reminder does not silence the hook" block "$(stdin_for "$t")"

t="$tmp/garbage.jsonl"
printf 'garbage\n{"broken":\n\000\001\n' > "$t"
expect "a malformed transcript passes" pass "$(stdin_for "$t")"

t="$tmp/big.jsonl"
{ prompt "go" 1; i=0; while [ $i -lt 2000 ]; do tool Bash $i; result $i; i=$((i + 1)); done; } > "$t"
start=$(date +%s)
expect "a large transcript blocks" block "$(stdin_for "$t")"
took=$(( $(date +%s) - start ))
if [ "$took" -gt 5 ]; then echo "FAIL large transcript took ${took}s"; fails=$((fails + 1)); fi

echo "$count checks, $fails failed"
[ "$fails" -eq 0 ]
