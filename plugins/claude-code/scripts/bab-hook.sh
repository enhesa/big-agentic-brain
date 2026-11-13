#!/bin/sh
# BAB hook: posts the hook event on stdin to <bab_url>/api/hook and prints BAB's answer.
# $1 = the whole request's time limit in seconds (default 3).
# The URL comes from CLAUDE_PLUGIN_OPTION_BAB_URL, which Claude Code sets from the plugin setting.
# It prints the answer only when it is JSON (HTTP 200, a JSON content type, a body that starts
# with "{") of at most 64 KB, so a captive portal's page never lands in the session.
# After a connection failure it skips the call for 5 minutes (a stamp in CLAUDE_PLUGIN_DATA; without
# that folder there is no skipping, never a stamp in a shared temp folder).
# Without a usable URL it makes no call and says so on stderr once per 5 minutes.
# Always exits 0 and prints nothing else on stdout: a hook must never break or block a session.
# Builtins where it can: every extra process costs time on Windows, on every prompt.

# stderr is kept on fd 3 for the one notice below; everything else on it is dropped.
exec 3>&2 2>/dev/null

MAX_BYTES=65536
QUIET_SECONDS=300
nl='
'

max_time=${1:-3}
case "$max_time" in
  '' | *[!0-9]*) max_time=3 ;;
esac

now=${EPOCHSECONDS:-$(date +%s)}

# The plugin's own data folder, or empty when Claude Code did not set it.
data=${CLAUDE_PLUGIN_DATA:-}
case "$data" in
  *'${'*) data= ;;
esac
if [ -n "$data" ] && [ ! -d "$data" ]; then
  mkdir -p "$data" || data=
fi

# True while the stamp in file $1 holds a time in the next QUIET_SECONDS. A stamp further ahead was not
# written by this script (or the clock went back): it is dropped, so it cannot silence the hooks for ever.
is_quiet() {
  [ -n "$data" ] && [ -f "$1" ] || return 1
  until_ts=
  read -r until_ts < "$1"
  case "$until_ts" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$until_ts" -le $((now + QUIET_SECONDS)) ] || { rm -f "$1"; return 1; }
  [ "$now" -lt "$until_ts" ]
}

# Writes a stamp QUIET_SECONDS ahead into file $1, never through a link left in its place.
mark_quiet() {
  [ -n "$data" ] || return 0
  rm -f "$1"
  (set -C; printf '%s' $((now + QUIET_SECONDS)) > "$1")
}

drain() {
  cat > /dev/null
  exit 0
}

# No usable URL: say so once per quiet period (stderr, not the session), then stay quiet.
no_url() {
  if ! is_quiet "$data/hook-no-url-until"; then
    printf '%s\n' 'BAB hooks: the bab_url setting (CLAUDE_PLUGIN_OPTION_BAB_URL) is unset or not an http(s) URL, so the hooks stay quiet.' >&3
    mark_quiet "$data/hook-no-url-until"
  fi
  drain
}

url=${CLAUDE_PLUGIN_OPTION_BAB_URL:-}
# Only an http or https URL.
case "$url" in
  https://* | http://*) ;;
  *) no_url ;;
esac
# A trailing slash would make a // path, which some proxies refuse.
url=${url%/}
# No quotes, spaces or shell characters.
case "$url" in
  *[!A-Za-z0-9.:/_-]*) no_url ;;
esac

stamp="$data/hook-offline-until"
is_quiet "$stamp" && drain

# The body, then one last line: status, connect time, size, content type.
out=$(curl -s --connect-timeout 1 --max-time "$max_time" --max-filesize "$MAX_BYTES" \
  -H 'Content-Type: application/json' --data-binary @- \
  -w "${nl}%{http_code} %{time_connect} %{size_download} %{content_type}" "$url/api/hook")
rc=$?
body=${out%"$nl"*}
meta=${out##*"$nl"}
code=${meta%% *}
meta=${meta#* }
connect=${meta%% *}
meta=${meta#* }
size=${meta%% *}
type=${meta#* }

# Off the network: the name does not resolve (6), the connection is refused or unreachable (7), the
# connect times out (28 before a connection), or TLS fails, as behind a captive portal (35, 60).
# Skip the next calls for a while instead of paying the connect timeout on every prompt.
offline=0
case "$rc" in
  6 | 7 | 35 | 60) offline=1 ;;
  28)
    case "$connect" in
      *[1-9]*) ;;
      *) offline=1 ;;
    esac
    ;;
esac
if [ "$offline" -eq 1 ]; then
  mark_quiet "$stamp"
  exit 0
fi
[ "$rc" -eq 0 ] || exit 0
[ -n "$data" ] && [ -f "$stamp" ] && rm -f "$stamp"

[ "$code" = "200" ] || exit 0
case "$type" in
  application/json | application/json\;*) ;;
  *) exit 0 ;;
esac
case "$size" in
  '' | *[!0-9]*) exit 0 ;;
esac
[ "$size" -gt 0 ] && [ "$size" -le "$MAX_BYTES" ] || exit 0
case "$body" in
  '{'*) printf '%s\n' "$body" ;;
esac
exit 0
