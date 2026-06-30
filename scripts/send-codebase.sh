#!/usr/bin/env bash
# Package the current codebase and send it to Releaseworks for analysis.
# Prints the snapshot JSON on success; exits non-zero with the error otherwise.
#
# Usage:
#   scripts/send-codebase.sh [source_id] [token] [backend]
# or via env (preferred — these are the project's Releaseworks config):
#   RW_SOURCE_ID=… RW_TOKEN=… scripts/send-codebase.sh
#
# backend defaults to https://api.prod.releaseworks.ai (override via the 3rd arg
# or RW_BACKEND). Requires: curl, jq, and git OR tar.
set -euo pipefail

source_id="${1:-${RW_SOURCE_ID:-}}"
token="${2:-${RW_TOKEN:-}}"
backend="${3:-${RW_BACKEND:-https://api.prod.releaseworks.ai}}"

if [ -z "$source_id" ] || [ -z "$token" ]; then
  echo "error: source_id and token are required (args or RW_SOURCE_ID/RW_TOKEN)" >&2
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

url="${backend%/}/v1/code/snapshots"
resp="$(curl -sS -X POST "$url" \
  -H "Authorization: Bearer ${token}" \
  -H "X-RW-Source-ID: ${source_id}" \
  -H 'Content-Type: application/gzip' \
  --data-binary "@${archive}" \
  -w $'\n%{http_code}')"
status="${resp##*$'\n'}"
payload="${resp%$'\n'*}"

if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "error: upload failed (HTTP $status): $payload" >&2
  exit 1
fi

echo "$payload" | jq .
