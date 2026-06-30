#!/usr/bin/env bash
# Package the current codebase and send it to Releaseworks for analysis, via the
# project's rw-sync Edge function (which holds the Releaseworks credentials and
# relays the upload). The script needs only project-public values, so every
# subsequent sync is just re-running it.
#
# Usage:
#   scripts/send-codebase.sh [sync_url] [anon_key]
# or via env (preferred — standard Supabase project config):
#   SUPABASE_URL=… SUPABASE_ANON_KEY=… scripts/send-codebase.sh
#
# sync_url defaults to ${SUPABASE_URL}/functions/v1/rw-sync (or pass RW_SYNC_URL).
# Requires: curl, jq, and git OR tar. No Releaseworks token needed.
set -euo pipefail

sync_url="${1:-${RW_SYNC_URL:-}}"
anon_key="${2:-${SUPABASE_ANON_KEY:-}}"

if [ -z "$sync_url" ] && [ -n "${SUPABASE_URL:-}" ]; then
  sync_url="${SUPABASE_URL%/}/functions/v1/rw-sync"
fi

if [ -z "$sync_url" ] || [ -z "$anon_key" ]; then
  echo "error: need the rw-sync URL and the Supabase anon key" >&2
  echo "       set SUPABASE_URL + SUPABASE_ANON_KEY (or pass [sync_url] [anon_key])" >&2
  exit 2
fi
command -v curl >/dev/null || {
  echo "error: curl is required" >&2
  exit 2
}
command -v jq >/dev/null || {
  echo "error: jq is required" >&2
  exit 2
}

MAX_BYTES=$((100 * 1024 * 1024)) # keep under the backend's archive limit

archive="$(mktemp -t rw-codebase.XXXXXX.tar.gz)"
cleanup() { rm -f "$archive"; }
trap cleanup EXIT

# Prefer git archive: deterministic and honours .gitignore. Otherwise tar the
# working tree, excluding heavy/secret paths.
if command -v git >/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git archive --format=tar.gz -o "$archive" HEAD
else
  command -v tar >/dev/null || {
    echo "error: need git or tar to package the codebase" >&2
    exit 2
  }
  tar czf "$archive" \
    --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='./dist' \
    --exclude='./build' \
    --exclude='./.next' \
    --exclude='./coverage' \
    --exclude='./.env' \
    --exclude='./.env.*' \
    --exclude='*.log' \
    --exclude='./.DS_Store' \
    .
fi

size="$(wc -c <"$archive")"
if [ "$size" -gt "$MAX_BYTES" ]; then
  echo "error: codebase archive is ${size} bytes, over the ${MAX_BYTES}-byte limit" >&2
  exit 1
fi

# Authenticate to the Edge function with the project's anon key (Supabase JWT
# verification). rw-sync relays to Releaseworks with the per-source token.
resp="$(curl -sS -X POST "$sync_url" \
  -H "Authorization: Bearer ${anon_key}" \
  -H "apikey: ${anon_key}" \
  -H 'Content-Type: application/gzip' \
  --data-binary "@${archive}" \
  -w $'\n%{http_code}')"
status="${resp##*$'\n'}"
payload="${resp%$'\n'*}"

if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "error: sync failed (HTTP $status): $payload" >&2
  exit 1
fi

echo "$payload" | jq .
