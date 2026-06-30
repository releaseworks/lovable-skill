#!/usr/bin/env bash
# Conformance checks: guard the bundled rw-backup edge function and SKILL.md
# against drift from the contract (canonical signing string, headers, signature
# format, secret names, JWT guardrail, deterministic scripts). Pure bash — no
# toolchain. Run from anywhere: test/conformance.sh
set -euo pipefail

cd "$(dirname "$0")/.."

AUTH=assets/rw-backup/auth.ts
INDEX=assets/rw-backup/index.ts
CONTRACT=reference/edge-function-contract.md
SKILL=SKILL.md

fails=0
check() { # check "description" -- <command...>
  local desc="$1"
  shift
  [ "$1" = "--" ] && shift
  if "$@" >/dev/null 2>&1; then
    echo "ok   - $desc"
  else
    echo "FAIL - $desc" >&2
    fails=$((fails + 1))
  fi
}
has() { grep -qF -- "$2" "$1"; }      # literal substring in file
hasre() { grep -qE -- "$2" "$1"; }    # regex in file
line_of() { grep -nF -- "$2" "$1" | head -1 | cut -d: -f1; }

# Secrets the function/entrypoint read.
check "auth.ts references RW_TOKEN" -- has "$AUTH" RW_TOKEN
check "auth.ts references RW_PUBLIC_KEY" -- has "$AUTH" RW_PUBLIC_KEY
check "index.ts references RW_SOURCE_ID" -- has "$INDEX" RW_SOURCE_ID

# Canonical string: method, path, query, timestamp, body-hash — in order.
canonical_in_order() {
  local a b c d e
  a=$(line_of "$AUTH" "req.method.toUpperCase()")
  b=$(line_of "$AUTH" "url.pathname")
  c=$(line_of "$AUTH" "canonicalQuery(url)")
  d=$(line_of "$AUTH" "String(ts)")
  e=$(line_of "$AUTH" "await sha256Hex(body)")
  [ -n "$a$b$c$d$e" ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ] &&
    [ "$c" -lt "$d" ] && [ "$d" -lt "$e" ]
}
check "canonical string parts are in order" -- canonical_in_order
check "canonical parts joined with newlines" -- has "$AUTH" '.join("\n")'

# Contract headers (code reads them lowercased).
check "uses Authorization header" -- has "$AUTH" authorization
check "uses X-RW-Timestamp header" -- has "$AUTH" x-rw-timestamp
check "uses X-RW-Signature header" -- has "$AUTH" x-rw-signature

# Signature format + curve + hash.
check "converts DER signatures to raw (derToRaw)" -- has "$AUTH" derToRaw
check "imports a P-256 key" -- has "$AUTH" 'namedCurve: "P-256"'
check "verifies with SHA-256" -- has "$AUTH" '"SHA-256"'

# Timestamp window.
check "enforces a 300s skew" -- hasre "$AUTH" 'SKEW_SECONDS[[:space:]]*=[[:space:]]*300'
check "contract documents the 300s window" -- has "$CONTRACT" 300

# Routes.
check "exposes /schema" -- has "$INDEX" 'route === "/schema"'
check "exposes /data" -- has "$INDEX" 'route === "/data"'

# SKILL.md essentials.
check "SKILL.md has a releaseworks name in frontmatter" -- hasre "$SKILL" '^name:[[:space:]]*releaseworks'
check "SKILL.md has a description" -- hasre "$SKILL" '^description:'
check "SKILL.md sets RW_SOURCE_ID" -- has "$SKILL" RW_SOURCE_ID
check "SKILL.md sets RW_TOKEN" -- has "$SKILL" RW_TOKEN
check "SKILL.md sets RW_PUBLIC_KEY" -- has "$SKILL" RW_PUBLIC_KEY
check "SKILL.md calls out disabling JWT verify" -- hasre "$SKILL" '(no-verify-jwt|JWT verification)'
check "SKILL.md POSTs the link-project hook" -- has "$SKILL" link-project
check "SKILL.md reports back with callback_token" -- has "$SKILL" callback_token
check "SKILL.md forbids inventing values" -- has "$SKILL" 'never invent values'
check "SKILL.md points to a support request on failure" -- has "$SKILL" 'support request'

# Removal capability.
check "SKILL.md documents removing the integration" -- hasre "$SKILL" 'Remove the Releaseworks integration'
check "SKILL.md deletes the edge function on removal" -- has "$SKILL" 'functions delete rw-backup'
check "SKILL.md unsets the secrets on removal" -- has "$SKILL" 'secrets unset'

# Deterministic scripts, referenced by SKILL.md and strict bash.
for s in scripts/link-project.sh scripts/report-backup-configured.sh scripts/send-codebase.sh; do
  check "SKILL.md invokes $s" -- has "$SKILL" "$s"
  check "$s has a bash shebang" -- has "$s" '#!/usr/bin/env bash'
  check "$s is strict (set -euo pipefail)" -- has "$s" 'set -euo pipefail'
done

# Codebase upload guardrails.
check "send-codebase.sh excludes .env" -- has scripts/send-codebase.sh .env
check "send-codebase.sh caps size" -- has scripts/send-codebase.sh MAX_BYTES
check "send-codebase.sh POSTs the ingest endpoint" -- has scripts/send-codebase.sh /v1/code/snapshots

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "all conformance checks passed"
