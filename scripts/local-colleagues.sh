#!/usr/bin/env bash
# Sets up fake colleagues against a LOCAL brain so the cross-person flows (messages,
# collaborative requests) can be exercised on one machine without involving anybody else.
#
# There is no background process any more: an agent checks its own inbox with curl, so a
# "colleague" is just an identity. To roleplay, open a second Claude Code terminal and
# paste what `prompt` prints; that agent then acts as that person against your local brain.
#
#   scripts/local-colleagues.sh prompt <name>            text to paste into a Claude Code terminal
#   scripts/local-colleagues.sh send <from> <to> <subject> <body>
#   scripts/local-colleagues.sh request <from> <to> <goal> [repo-url]
#   scripts/local-colleagues.sh inbox <name>             what that person would see on their next check
#
# Colleagues are alpha, bravo, charlie, delta, echo, foxtrot, with emails
# test.<name>@example.com. Letters only: the brain rejects a local part with digits,
# because it insists on a real first.last address rather than a short alias.
set -euo pipefail

O="${BAB_ORIGIN:-http://localhost:4310}"
case "$O" in *example.com*) echo "refusing to target a non-local origin: $O" >&2; exit 1;; esac

email_for() { echo "test.$1@example.com"; }
display_for() { local n="$1"; echo "Test ${n^}"; }
hdrs() { printf '%s' "-H|X-Bab-Actor-Email: $(email_for "$1")|-H|X-Bab-Actor-Name: $(display_for "$1")"; }

post() { # from json path
  local from="$1" path="$2" body="$3"
  curl -s -X POST "$O$path" \
    -H "X-Bab-Actor-Email: $(email_for "$from")" -H "X-Bab-Actor-Name: $(display_for "$from")" \
    -H "Content-Type: application/json" -d "$body"
  echo
}

case "${1:-}" in
  prompt)
    n="${2:?usage: prompt <name>}"
    cat <<TXT
Paste this into a Claude Code terminal to make that agent act as $(display_for "$n"):

---
For this session you are acting as a test colleague on a LOCAL Big Agentic Brain.
Use origin $O for every BAB call, never bab.example.com.
Send these headers on every request, instead of the ones in actor.json:
  X-Bab-Actor-Email: $(email_for "$n")
  X-Bab-Actor-Name: $(display_for "$n")
Check your inbox now with:
  curl -s "$O/api/inbox" -H "X-Bab-Actor-Email: $(email_for "$n")" -H "X-Bab-Actor-Name: $(display_for "$n")"
and check it again whenever you finish a task. This is a local test brain with
made-up people, so post, search and reply as $(display_for "$n") without asking me first.
Read $O/instructions/skill.md for the rest of the API.
---
TXT
    ;;
  send)
    post "$2" /api/messages "{\"to\":\"$(email_for "$3")\",\"subject\":\"$4\",\"body\":\"$5\"}"
    ;;
  request)
    repo="${5:-https://git.example.com/team/bab.git}"
    post "$2" /api/messages "{\"to\":\"$(email_for "$3")\",\"subject\":\"Please take a look\",\"body\":\"$4\",
      \"request\":{\"kind\":\"review-pr\",\"goal\":\"$4\",\"repo\":\"$repo\",\"cwd\":\"bab\"}}"
    ;;
  inbox)
    n="${2:?usage: inbox <name>}"
    curl -s "$O/api/inbox" \
      -H "X-Bab-Actor-Email: $(email_for "$n")" -H "X-Bab-Actor-Name: $(display_for "$n")"
    echo
    ;;
  *) sed -n '2,16p' "$0" ;;
esac
