#!/bin/sh
# Prints the HTTP headers Claude Code sends to the BAB MCP server (headersHelper).
# $1 = plugin data dir (absolute path). Keeps a random per-device secret there.
# No network. stdout is one JSON object and nothing else.
# On failure it prints {"X-Bab-Device-Error":"<code>"} and exits 0. Codes:
#   bad-dir    $1 is missing, not absolute, or still holds an unexpanded ${...}
#   no-random  /dev/urandom is unreadable or gave a weak result
#   no-write   the data dir or the secret file cannot be written
# (no-shell is printed by bab-headers.cmd when no sh is found on Windows.)

exec 2>/dev/null
umask 077

fail() {
  printf '{"X-Bab-Device-Error":"%s"}' "$1"
  exit 0
}

is_hex64() {
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

# Windows-style paths (X:\... or X:/...) only make sense under Git Bash and friends.
win=0
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) win=1 ;;
esac

if [ "$win" -eq 1 ]; then
  dir=$(printf '%s' "$1" | LC_ALL=C tr '\' '/')
else
  dir="$1"
fi
case "$dir" in
  '' | *'${'*) fail bad-dir ;;
  /*) ;;
  [A-Za-z]:/*) [ "$win" -eq 1 ] || fail bad-dir ;;
  *) fail bad-dir ;;
esac

mkdir -p "$dir"
[ -d "$dir" ] || fail no-write
f="$dir/device-secret"

read_secret() { cat "$f" | LC_ALL=C tr -d ' \r\n'; }

# Take f.lock (mkdir is atomic). Waits up to about 3 s for another process,
# then treats the lock as stale and takes over.
lock="$f.lock"
acquire_lock() {
  if sleep 0.1; then step=0.1; else step=1; fi
  start=$(date +%s)
  until mkdir "$lock"; do
    # The holder may have fixed the file already: no need for the lock then.
    is_hex64 "$(read_secret)" && return 1
    if [ $(($(date +%s) - start)) -ge 3 ]; then
      rmdir "$lock"
      mkdir "$lock"
      return 0
    fi
    sleep "$step"
  done
  return 0
}

secret=$(read_secret)
if ! is_hex64 "$secret"; then
  new=$(head -c 32 /dev/urandom | od -An -tx1 | LC_ALL=C tr -d ' \n')
  is_hex64 "$new" || fail no-random

  tmp="$f.$$.tmp"
  printf '%s' "$new" > "$tmp" || { rm -f "$tmp"; fail no-write; }

  # ln never replaces an existing file, so parallel first runs end with one secret.
  ln "$tmp" "$f"
  secret=$(read_secret)
  if ! is_hex64 "$secret"; then
    # No hard links here, or $f holds junk: replace it, one process at a time.
    if acquire_lock; then
      if ! is_hex64 "$(read_secret)"; then
        mv -f "$tmp" "$f"
      fi
      rmdir "$lock"
    fi
    secret=$(read_secret)
  fi
  rm -f "$tmp"
  is_hex64 "$secret" || fail no-write
fi

label=$(printf '%s %s' "$(uname -s)" "$(uname -n)" | LC_ALL=C tr -cd 'A-Za-z0-9 ._-' | cut -c1-60)

printf '{"X-Bab-Device":"%s","X-Bab-Device-Label":"%s"}' "$secret" "$label"
