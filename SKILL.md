---
name: releaseworks
description: >-
  Manage the Releaseworks integration for a Lovable project — both initial setup
  and ongoing use. Set up: link for availability monitoring and deploy the
  rw-backup Supabase Edge function for automated backups. Ongoing: send new
  versions of the codebase to Releaseworks for analysis. Also removes the
  integration. Use when a user wants to connect their Lovable/Supabase project to
  Releaseworks, enable backups, send/analyze their codebase, remove/disconnect
  Releaseworks, or pastes a Releaseworks link_token.
---

# Releaseworks

This skill manages a Lovable project's Releaseworks integration — both **setup**
and **ongoing use**. You (the agent) perform the work, since you have access to
this project's Supabase; Releaseworks does not.

What it covers:

- **Set up** — link the project (availability monitoring) and deploy the
  `rw-backup` Edge function for automated backups (one task; see below).
- **Send code for analysis** — package and upload the current codebase; run this
  again whenever you want Releaseworks to analyze a new version.
- **Remove** — uninstall the integration.

Pick the matching section below based on what the user asks for. The first-time
setup is the **Setup** steps; the others are independent and reusable.

## Critical rule: never invent values

Every value you send to or set in Supabase — API hostnames/URLs, `source_id`,
`token`, `public_key`, `callback_url`, `callback_token` — **must come verbatim
from a Releaseworks API response or this skill's files.** Do **not** guess,
fabricate, derive, or "fix up" any of them, and do not fall back to plausible
defaults if a value is missing.

If any API call fails, returns a non-2xx status, or returns a response that is
missing an expected field or has an unexpected shape (see each step), **stop
immediately**. Do not continue, do not improvise substitutes. Tell the user
plainly:

- which step failed and what was wrong (e.g. "the link-project response was
  missing `public_key`"),
- that setup was **not** completed, and
- that they should **open a Releaseworks support request**
  (https://releaseworks.ai/support) with that error so the team can help.

A half-configured integration with made-up values is worse than a clean failure.

## Setup

Run this the first time a user connects a project (or pastes a `link_token`).

**Input:** `link_token` — provided in the user's prompt (looks like
`rlw_live_…`). **Treat it as a secret: never write it into the codebase.** If the
user didn't provide one, ask them to copy the setup prompt from Releaseworks
(Settings → Connect Lovable) and paste it.

Do these steps in order. If a step fails, stop and tell the user exactly which
step failed and the error; do not continue.

### 1. Gather project metadata

Collect from this Lovable project:

- `lovable_project_id` — the project's ID
- `name` — the project's **display name** (the human-readable title), not the
  URL slug
- `primary_domain` — the published domain. **Prefer a custom domain** (e.g.
  `https://app.acme.com`) whenever the project has one; only fall back to the
  `*.lovable.app` domain if there is no custom domain.

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

**Validate the response before continuing.** It must be valid JSON with
`linked: true` and a non-empty `source_id`, `token`, `public_key`,
`callback_url`, and `callback_token`, and `public_key` must be a PEM block
(begins with `-----BEGIN PUBLIC KEY-----`). If the script exited non-zero, or any
of those fields is missing/empty/wrong-shaped, **stop** and follow the *Critical
rule* above (tell the user what was missing and to open a support request). Do
**not** invent or guess any of these values.

Use exactly the values returned. Keep them in memory only; **do not commit
`token` or `callback_token`.** (Requires `curl` and `jq`.)

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

## Remove the Releaseworks integration

Use this when the user asks to **remove / uninstall / disconnect Releaseworks**
or **stop backups** for the project. It undoes what onboarding set up.

1. Delete the deployed Edge function (CLI equivalent:
   `supabase functions delete rw-backup`).
2. Unset the Supabase secrets it used (CLI equivalent:
   `supabase secrets unset RW_SOURCE_ID RW_TOKEN RW_PUBLIC_KEY`).
3. Delete `supabase/functions/rw-backup/` from the project.
4. Tell the user to finish in the Releaseworks dashboard: **disable/delete the
   backup source** (this stops scheduled backups and, if wanted, removes stored
   backups) and unlink the project from monitoring. The skill can't do this —
   it's a Releaseworks-side action behind the user's account.

Report each step's outcome; if a step fails, say which and stop. Removing the
function and secrets is enough to stop Releaseworks reaching the database; step 4
stops scheduling and cleans up the Releaseworks side.

## Guardrails

- **Never invent values.** API hostnames/URLs, `source_id`, `token`,
  `public_key`, and the callback values must come verbatim from a Releaseworks
  API response — never guessed, derived, or defaulted. On any failed or
  unexpected response, stop and tell the user to open a Releaseworks support
  request (see *Critical rule*); don't improvise.
- Never write `link_token`, `token`, `callback_token`, or `public_key` into the
  repository, comments, or commit messages. Secrets go only into Supabase
  secrets.
- Deploy with JWT verification **off** — with it on, every Releaseworks request
  is rejected before reaching the function.
- Copy the `assets/rw-backup/` files unchanged.
- The codebase upload must never include secrets — `send-codebase.sh` excludes
  `.env` files; don't override that.
