#!/usr/bin/env bash
# Report the deployed rw-backup function URL back to Releaseworks, which records
# it on the source and triggers the first verification backup.
# Prints the JSON response body to stdout; exits non-zero on any HTTP error.
#
# Usage:
#   scripts/report-backup-configured.sh <callback_url> <callback_token> <function_url>
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <callback_url> <callback_token> <function_url>" >&2
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

callback_url="$1"

body="$(jq -n \
  --arg callback_token "$2" \
  --arg function_url "$3" \
  '{callback_token: $callback_token, function_url: $function_url}')"

resp="$(curl -sS -X POST "$callback_url" \
  -H 'Content-Type: application/json' \
  --data "$body" \
  -w $'\n%{http_code}')"
status="${resp##*$'\n'}"
payload="${resp%$'\n'*}"

if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "error: callback failed (HTTP $status): $payload" >&2
  exit 1
fi

echo "$payload" | jq .
