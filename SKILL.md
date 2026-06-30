---
name: releaseworks-setup
description: >-
  Set up Releaseworks for a Lovable project: link it for availability
  monitoring, configure automated database backups by deploying the rw-backup
  Supabase Edge function, and send the codebase to Releaseworks for analysis.
  Use when a user wants to connect their Lovable/Supabase project to
  Releaseworks, enable backups, send/analyze their codebase, or pastes a
  Releaseworks link_token.
---

# Releaseworks setup

This skill links a Lovable project to Releaseworks (availability monitoring) and
configures automated backups in one task. You (the agent) perform the work — you
have access to this project's Supabase; Releaseworks does not.

## Inputs

- `link_token` — provided in the user's prompt (looks like `rlw_live_…`).
  **Treat it as a secret: never write it into the codebase.**

If the user didn't provide a `link_token`, ask them to copy the setup prompt
from Releaseworks (Settings → Connect Lovable) and paste it.

## Steps

Do these in order. If a step fails, stop and tell the user exactly which step
failed and the error; do not continue.

### 1. Gather project metadata

Collect from this Lovable project:

- `lovable_project_id` — the project's ID
- `name` — the project's name
- `primary_domain` — the primary published domain (e.g. `https://myapp.lovable.app`)

### 2. Link the project and get backup credentials

Run the script (it does the HTTP POST and prints the JSON response):

```
scripts/link-project.sh "<link_token>" "<lovable_project_id>" "<name>" "<primary_domain>"
```

It prints the backup-setup payload to stdout; parse these fields from it:

```json
{
  "linked": true,
  "source_id": "src_…",
  "token": "rw_tkn_…",
  "public_key": "-----BEGIN PUBLIC KEY-----\n…",
  "backend": "https://api.prod.releaseworks.ai",
  "callback_url": "https://releaseworks.ai/api/public/hooks/backup-configured",
  "callback_token": "…"
}
```

The script exits non-zero and prints the error on any HTTP failure — if so, stop
and report it. Keep these values in memory only; **do not commit `token` or
`callback_token`.** (Requires `curl` and `jq`.)

### 3. Add the Edge function to the project

Create these files **verbatim** from this skill's `assets/rw-backup/` directory:

- `supabase/functions/rw-backup/index.ts`
- `supabase/functions/rw-backup/auth.ts`
- `supabase/functions/rw-backup/introspect.ts`

Do not modify them — they implement the exact request-authentication contract
the Releaseworks backend requires (see `reference/edge-function-contract.md`).

### 4. Set the function's secrets in Supabase

Set these as Supabase secrets (project secrets / Edge function env), **not** in
the repo:

- `RW_SOURCE_ID` = `source_id`
- `RW_TOKEN` = `token`
- `RW_PUBLIC_KEY` = `public_key`

### 5. Deploy the function

Deploy `rw-backup` **with JWT verification disabled** — Releaseworks
authenticates with its own bearer-token + signature scheme, not a Supabase user
JWT. (CLI equivalent: `supabase functions deploy rw-backup --no-verify-jwt`.)

The deployed URL will be:
`https://<project-ref>.supabase.co/functions/v1/rw-backup`

### 6. Report the function URL back to Releaseworks

Run the script so Releaseworks records the function and runs a first verification
backup (pass `callback_url` and `callback_token` from step 2):

```
scripts/report-backup-configured.sh "<callback_url>" "<callback_token>" "<deployed rw-backup URL>"
```

It exits non-zero and prints the error on any HTTP failure — if so, stop and
report it.

### 7. Confirm to the user

Summarize: project linked (monitoring on), `rw-backup` deployed, secrets set, and
that Releaseworks is running the first verification backup. Tell them they can
manage schedules and download backups in the Releaseworks dashboard.

## Send the codebase for analysis

Use this when the user asks to **send / upload / analyze their codebase** with
Releaseworks. It's independent of the onboarding steps above, but needs the
project's Releaseworks config from onboarding: `RW_SOURCE_ID` and `RW_TOKEN`.
(The backend defaults to `https://api.prod.releaseworks.ai`; set `RW_BACKEND`
only to override it.)

1. Ensure `RW_SOURCE_ID` and `RW_TOKEN` are available (from the project's
   Releaseworks / Supabase config). If they aren't, the project hasn't been
   onboarded yet — run the setup steps above first.
2. Run the script — it packages the codebase (via `git archive`, honouring
   `.gitignore`) and uploads it:

   ```
   RW_SOURCE_ID="<source_id>" RW_TOKEN="<token>" scripts/send-codebase.sh
   ```

3. It prints the snapshot JSON (`snapshot_id`, `file_count`, `size_bytes`). Tell
   the user the codebase was sent and can be viewed/analyzed in Releaseworks. The
   script exits non-zero with the error on failure — if so, stop and report it.

## Guardrails

- Never write `link_token`, `token`, `callback_token`, or `public_key` into the
  repository, comments, or commit messages. Secrets go only into Supabase
  secrets.
- Deploy with JWT verification **off** — with it on, every Releaseworks request
  is rejected before reaching the function.
- Copy the `assets/rw-backup/` files unchanged.
- The codebase upload must never include secrets — `send-codebase.sh` excludes
  `.env` files; don't override that.
