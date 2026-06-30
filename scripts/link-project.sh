#!/usr/bin/env bash
# Link a Lovable project to Releaseworks and obtain the backup-setup payload.
# Prints the JSON response body to stdout; exits non-zero on any HTTP error.
#
# Usage:
#   scripts/link-project.sh <link_token> <lovable_project_id> <name> <primary_domain>
#
# Env:
#   RELEASEWORKS_BASE   override the base URL (default https://releaseworks.ai)
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <link_token> <lovable_project_id> <name> <primary_domain>" >&2
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

base="${RELEASEWORKS_BASE:-https://releaseworks.ai}"
url="${base%/}/api/public/hooks/link-project"

# Build the body with jq so values are correctly JSON-escaped.
body="$(jq -n \
  --arg link_token "$1" \
  --arg lovable_project_id "$2" \
  --arg name "$3" \
  --arg primary_domain "$4" \
  '{link_token: $link_token, lovable_project_id: $lovable_project_id, name: $name, primary_domain: $primary_domain}')"

# Capture body and HTTP status (status appended on its own trailing line).
resp="$(curl -sS -X POST "$url" \
  -H 'Content-Type: application/json' \
  --data "$body" \
  -w $'\n%{http_code}')"
status="${resp##*$'\n'}"
payload="${resp%$'\n'*}"

if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
  echo "error: link-project failed (HTTP $status): $payload" >&2
  exit 1
fi

# Emit the parsed JSON so the caller can read source_id, token, callback_*, etc.
echo "$payload" | jq .
