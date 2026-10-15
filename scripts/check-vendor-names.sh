#!/usr/bin/env bash
# Fails when a vendor name or a real person's name appears outside scripts/vendor-allowlist.txt.
# Allowlist format: one "path:substring" per line. The org slug enhesa/big-agentic-brain is always allowed.
set -u
cd "$(dirname "$0")/.."
allow="scripts/vendor-allowlist.txt"
# Person-name checks run from an untracked list: set VENDOR_EXTRA_PATTERN in the environment.
PATTERN='enhesa|forge\.enhesa|atlassian\.net/wiki|azurecr|devenhesa|docs/specs/|docs/evals/|docs/plans/|\b(EHSREQSRV|EHSARCH|EHSESG|TECHLEADS|SOFTARCH|DPUSH)-[0-9]+'
[ -n "${VENDOR_EXTRA_PATTERN:-}" ] && PATTERN="$PATTERN|$VENDOR_EXTRA_PATTERN"
hits=$( {
  grep -rniE "$PATTERN" app lib content plugins proxy.ts instrumentation.ts instrumentation-node.ts README.md docs tests \
    --include=*.ts --include=*.tsx --include=*.mjs --include=*.md --include=*.json --include=*.css --include=*.sh 2>/dev/null
  grep -rniE "$PATTERN" Dockerfile docker-compose*.yml scripts .gitignore .github 2>/dev/null
} | sort -u || true)
bad=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  path=${line%%:*}
  [ "$path" = "scripts/check-vendor-names.sh" ] && continue
  [ "$path" = "scripts/vendor-allowlist.txt" ] && continue
  stripped=${line//enhesa\/big-agentic-brain/}
  if ! printf '%s' "${stripped#*:}" | grep -qiE "$PATTERN"; then continue; fi
  ok=0
  if [ -f "$allow" ]; then
    while IFS= read -r rule; do
      [ -z "$rule" ] && continue
      case "$rule" in \#*) continue;; esac
      rpath=${rule%%:*}; rsub=${rule#*:}
      if [ "$path" = "$rpath" ] && [[ "$line" == *"$rsub"* ]]; then ok=1; break; fi
    done < "$allow"
  fi
  [ $ok -eq 0 ] && bad+="$line"$'\n'
done <<< "$hits"
if [ -n "$bad" ]; then
  printf '%s' "$bad"
  echo "Vendor or personal names found (see scripts/vendor-allowlist.txt)." >&2
  exit 1
fi
echo "vendor scan clean"
