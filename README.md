# releaseworks

The **Releaseworks Agent Skill** (skill name: `releaseworks`) — it manages a
Lovable project's Releaseworks integration end to end, both initial setup and
ongoing use:

- **Set up** — link the project for availability monitoring **and** deploy the
  `rw-backup` Supabase Edge function for automated backups, in one task.
- **Send code for analysis** — package and upload the current codebase; re-run
  any time to analyze a new version.
- **Remove** — uninstall the integration (delete the function + secrets).

The skill is executed by the Lovable agent — Lovable has access to the project's
Supabase, so it creates the function, sets secrets, and deploys. Releaseworks
itself never touches the customer's database.

## Setup flow

The user copies a short setup prompt from Releaseworks (Settings → Connect
Lovable) that contains a `link_token` and tells Lovable to run this skill.
Lovable then follows the **Setup** steps in [`SKILL.md`](SKILL.md):

1. Collect the project's id / name / primary domain.
2. `POST /api/public/hooks/link-project` → links the project and returns the
   backup credentials (`source_id`, `token`, `public_key`, `callback_url`,
   `callback_token`).
3. Write `supabase/functions/rw-backup/*` from [`assets/rw-backup/`](assets/rw-backup).
4. Set Supabase secrets `RW_SOURCE_ID`, `RW_TOKEN`, `RW_PUBLIC_KEY`.
5. Deploy `rw-backup` with JWT verification disabled.
6. `POST` the deployed URL to `callback_url` → Releaseworks records it and runs
   the first verification backup.

The only secret the user handles is the short-lived `link_token`. The per-source
`token` flows machine-to-machine into Supabase secrets and is never committed.

Ongoing actions (sending code, removing the integration) are separate sections in
[`SKILL.md`](SKILL.md) and reuse the same per-project config.

## What's in here

```
SKILL.md            the agent instructions (the skill itself)
scripts/            deterministic shell scripts for the HTTP API calls (curl + jq)
assets/rw-backup/   the Edge function source Lovable deploys (verbatim)
reference/          vendored edge-function contract (the interface spec)
test/               conformance.sh — drift checks for the assets + SKILL.md
```

The HTTP calls the skill makes (linking the project, reporting the function URL)
are encapsulated in `scripts/` rather than free-form requests, so they behave
identically every run: strict bash, JSON built/validated with `jq`, non-zero exit
with the error on any HTTP failure. The scripts require `curl` and `jq`.

This repo **owns the `rw-backup` Edge function source**. The
[`ai2p-backend`](https://github.com/releaseworks/ai2p-backend) repo owns the
**interface** — [`reference/edge-function-contract.md`](reference/edge-function-contract.md)
is vendored from there. `test/conformance.sh` fails if the bundled function or
SKILL.md drifts from the contract (canonical signing string, headers, DER→raw
P-256 signatures, the three secret names, the ±300s window, the JWT guardrail).

## Development

No toolchain — it's bash scripts, Deno Edge-function assets, and markdown. Run
the drift checks with:

```bash
./test/conformance.sh
```

The `assets/` files are **Deno** Edge-function code (they import from `https://…`
and use `Deno.*`); they're shipped verbatim.

## Delivery

Published as an installable Agent Skill (agentskills.io-style). If a host can't
install skills yet, `SKILL.md` is written to double as a self-contained prompt:
its steps are explicit enough to paste directly, with the Edge-function source
fetched from this repo's `assets/rw-backup/`.
