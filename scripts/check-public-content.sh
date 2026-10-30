#!/usr/bin/env bash
# Fails when public text holds personal data, internal hosts or IPs, workplace-tool links, ticket keys or token-shaped secrets.
# Usage:
#   check-public-content.sh                    scan tracked files (pnpm check runs this)
#   check-public-content.sh FILE...            scan the given files, plus the vendor-name pattern
#   check-public-content.sh --text             scan stdin (a PR title and body), plus the vendor-name pattern
#   check-public-content.sh --commit-messages  scan stdin (git log --format=%x1e%n%B: a line holding only 0x1e starts each message);
#                                              ignores the "type(KEY-1): " scope and the PR owner in a merge subject, and trailers
# Exceptions for tracked files go in scripts/public-allowlist.txt as "check:path:substring" (substring * = whole file).
# Emails on lines allowed by scripts/vendor-allowlist.txt are allowed too. Stdin text has no exceptions: edit the text instead.
set -u
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then echo "check-public-content.sh needs bash 4 or newer" >&2; exit 2; fi
cd "$(dirname "$0")/.."
self="scripts/check-public-content.sh"
allow="scripts/public-allowlist.txt"
vendor_allow="scripts/vendor-allowlist.txt"

# Reserved example domains (RFC 2606, RFC 6761) and GitHub's noreply domain.
SAFE_DOMAIN='^(example\.(com|org|net)|.*\.example(\.(com|org|net))?|.*\.test|.*\.invalid|.*\.localhost|localhost|users\.noreply\.github\.com)$'
SAFE_HOST='^(example\.(com|org|net)|.*\.example(\.(com|org|net))?|.*\.test|.*\.invalid|.*\.localhost|localhost)$'
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
HOST='([A-Za-z0-9-]+\.)+(internal|corp|intranet)(\.[A-Za-z0-9-]+)*\b|([A-Za-z0-9-]+\.)*cluster\.local\b'
IP='\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})\b'
URL='[A-Za-z0-9-]+\.atlassian\.net|[A-Za-z0-9.:-]*/wiki/spaces/|teams\.microsoft\.com|teams\.live\.com|[A-Za-z0-9-]+\.sharepoint\.com|[A-Za-z0-9-]+\.slack\.com|dev\.azure\.com/[A-Za-z0-9]|[A-Za-z0-9-]+\.visualstudio\.com'
TICKET='[A-Za-z0-9.-]*/browse/[A-Z][A-Z0-9]{1,9}-[0-9]+|(^|[^A-Za-z])(feat|fix|chore|docs|refactor|test|tests|ci|build|perf|style|revert)\([A-Z][A-Z0-9]{1,9}-[0-9]+\)|(^|[^A-Za-z])([Jj]ira|JIRA|[Tt]icket|TICKET)( key)?[ :#]+[A-Z][A-Z0-9]{1,9}-[0-9]+'
SECRET='gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9A-Za-z]{16,}|npm_[A-Za-z0-9]{36}|AccountKey=[A-Za-z0-9+/=]{20,}'
# The vendor-name pattern is read from the vendor scan so it lives in one place.
VENDOR=$(sed -n "s/^PATTERN='\(.*\)'\$/\1/p" scripts/check-vendor-names.sh)
[ -n "${VENDOR_EXTRA_PATTERN:-}" ] && VENDOR="$VENDOR|$VENDOR_EXTRA_PATTERN"
[ -n "$VENDOR" ] || { echo "could not read the vendor pattern from scripts/check-vendor-names.sh" >&2; exit 2; }

mode=files
input=""
cleanup() { [ -n "$input" ] && rm -f "$input"; }
trap cleanup EXIT
case "${1:-}" in
  --text|--commit-messages)
    mode=${1#--}
    input=$(mktemp)
    if [ "$mode" = commit-messages ]; then
      # On each subject line only: drop the conventional-commit scope (it may name a ticket) and the
      # PR owner in "Merge pull request #1 from owner/branch". Drop co-author and sign-off trailers.
      tr -d '\r' | awk -v m="$(printf '\036')" '
        BEGIN { subj = 1 }
        $0 == m { subj = 1; next }
        tolower($0) ~ /^(co-authored-by|signed-off-by):/ { next }
        subj {
          if (match($0, /^[a-z]+\([A-Z][A-Z0-9]*-[0-9]+\)/)) { p = index($0, "("); $0 = substr($0, 1, p - 1) substr($0, RLENGTH + 1) }
          sub(/^Merge pull request #[0-9]+ from [^\/ ]+\//, "Merge pull request from ")
          subj = 0
        }
        { print }' > "$input"
    else
      tr -d '\r' > "$input"
    fi
    files=("$input")
    ;;
  "")
    listed=$(mktemp)
    git ls-files -z > "$listed" || { rm -f "$listed"; echo "git ls-files failed: run this inside the repository" >&2; exit 2; }
    files=()
    while IFS= read -r -d '' f; do
      case "$f" in pnpm-lock.yaml|"$self"|"$allow"|"$vendor_allow") continue;; esac
      [ -f "$f" ] && files+=("$f")
    done < "$listed"
    rm -f "$listed"
    [ ${#files[@]} -gt 0 ] || { echo "no tracked files to scan" >&2; exit 2; }
    mode=tracked
    ;;
  *)
    files=("$@")
    ;;
esac

rules=()
if [ "$mode" = tracked ] && [ -f "$allow" ]; then
  while IFS= read -r rule || [ -n "$rule" ]; do
    rule=${rule%$'\r'}
    [ -z "$rule" ] && continue
    case "$rule" in \#*) continue;; esac
    rules+=("$rule")
  done < "$allow"
fi
vrules=()
if [ "$mode" = tracked ] && [ -f "$vendor_allow" ]; then
  while IFS= read -r rule || [ -n "$rule" ]; do
    rule=${rule%$'\r'}
    [ -z "$rule" ] && continue
    case "$rule" in \#*) continue;; esac
    vrules+=("$rule")
  done < "$vendor_allow"
fi

allowed() { # check path line
  local r rc rest rp rs
  for r in "${rules[@]+"${rules[@]}"}"; do
    rc=${r%%:*}; rest=${r#*:}; rp=${rest%%:*}; rs=${rest#*:}
    [ "$rc" = "$1" ] || [ "$rc" = "*" ] || continue
    [ "$rp" = "$2" ] || continue
    if [ "$rs" = "*" ] || [[ "$3" == *"$rs"* ]]; then return 0; fi
  done
  if [ "$1" = email ]; then
    for r in "${vrules[@]+"${vrules[@]}"}"; do
      rp=${r%%:*}; rs=${r#*:}
      if [ "$rp" = "$2" ] && [[ "$3" == *"$rs"* ]]; then return 0; fi
    done
  fi
  return 1
}

safe_match() { # check match -> 0 when the match is a harmless placeholder
  local m d
  m=$2
  case "$1" in
    email)
      d=${m#*@}; d=${d,,}
      # git@github.com:org/repo is an SSH remote, not a person. Other hosts may be internal.
      [ "${m%%@*}" = git ] && [[ "$d" =~ ^(github\.com|gitlab\.com|bitbucket\.org)$ ]] && return 0
      [[ "$d" =~ $SAFE_DOMAIN ]] && return 0 ;;
    host|url|ticket)
      d=${m,,}; d=${d%%/*}; d=${d%%:*}
      [[ "$d" =~ $SAFE_HOST ]] && return 0 ;;
  esac
  return 1
}

bad=""
scan() { # check pattern grep-flags
  local check=$1 pat=$2 flags=$3 hit path rest lnum m label
  local -A lines=()
  [ ${#files[@]} -eq 0 ] && return
  # Full lines first (for allowlist substrings), then one match per output line. No fork per hit.
  while IFS= read -r hit; do
    path=${hit%%$'\001'*}; rest=${hit#*$'\001'}; lnum=${rest%%:*}
    lines["$path:$lnum"]=${rest#*:}
  done < <(printf '%s\0' "${files[@]}" | xargs -0 grep -ZHnIE $flags -- "$pat" 2>/dev/null | tr '\000' '\001')
  [ ${#lines[@]} -eq 0 ] && return
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    path=${hit%%$'\001'*}; rest=${hit#*$'\001'}; lnum=${rest%%:*}; m=${rest#*:}
    safe_match "$check" "$m" && continue
    [ "$mode" = tracked ] && allowed "$check" "$path" "${lines["$path:$lnum"]-}" && continue
    [ "$check" = ip ] && [[ "$m" =~ [0-9]+(\.[0-9]+){3} ]] && m=${BASH_REMATCH[0]}
    label=$path
    [ -n "$input" ] && [ "$path" = "$input" ] && label="<$mode>"
    bad+="$label:$lnum: [$check] $m"$'\n'
  done < <(printf '%s\0' "${files[@]}" | xargs -0 grep -ZHnoIE $flags -- "$pat" 2>/dev/null | tr '\000' '\001')
}

scan email "$EMAIL" ""
scan host "$HOST" "-i"
scan ip "$IP" ""
scan url "$URL" "-i"
scan ticket "$TICKET" ""
scan secret "$SECRET" ""
# Tracked files get the vendor scan from check-vendor-names.sh; other text gets it here.
if [ "$mode" != tracked ]; then
  stripped=$(mktemp)
  for f in "${files[@]}"; do
    sed 's#enhesa/big-agentic-brain##Ig' "$f" > "$stripped" 2>/dev/null || continue
    lbl=$f; [ -n "$input" ] && [ "$f" = "$input" ] && lbl="<$mode>"
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      bad+="$lbl:${hit%%:*}: [vendor] $(printf '%s' "${hit#*:}" | grep -oiE -- "$VENDOR" | head -1)"$'\n'
    done < <(grep -niE -- "$VENDOR" "$stripped")
  done
  rm -f "$stripped"
fi

if [ -n "$bad" ]; then
  printf '%s' "$bad" | sort -u
  echo "Public text must not hold personal data, internal hosts or IPs, workplace links, ticket keys or secrets. Use example.com, user@example.com and 192.0.2.x. Exceptions for tracked files: $allow." >&2
  exit 1
fi
echo "public content scan clean"
