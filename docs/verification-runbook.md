# Trusted local verification runbook

This flow is for this machine. It assumes three things are already true:

1. OG Claude Code is installed and authenticated.
2. The plugin/OpenCode command you want to verify is installed locally.
3. You already generated a candidate manifest for the target version.

## What the runner does

`scripts/verification/run-live-verification.ts` starts a local MITM proxy, runs the same scenario through OG Claude Code and the plugin, captures both sanitized requests, compares the required fingerprint fields, and writes a JSON report.

It does **not** write raw bearer tokens or raw request bodies into the report.

`scripts/verification/promote-verified.ts` reads that report, checks candidate-manifest values against the live-verified values, and promotes only the fields that actually matched.

## Quick start

Run the baseline scenario:

```bash
bun scripts/verification/run-live-verification.ts \
  --version 2.1.109 \
  --scenario minimal-hi
```

Then promote the verified fields:

```bash
bun scripts/verification/promote-verified.ts \
  --version 2.1.109 \
  --report manifests/reports/verification/2.1.109-<timestamp>.json
```

## Scenario files

Scenario definitions live in `scripts/verification/scenarios/`.

- `minimal-hi.json` — baseline message request
- `tool-search.json` — tool registration and optional betas
- `append-system-prompt.json` — billing/identity block structure
- `oauth-token-refresh.json` — manual OAuth refresh validation

By default the runner skips `oauth-token-refresh` because a real refresh usually needs a custom command or a deliberately expired token.

## Command templates

The runner shells out with templates. The default commands are:

- OG Claude Code: `claude --print {prompt}`
- Plugin/OpenCode: `opencode run {prompt}`

If your local setup differs, override them:

```bash
bun scripts/verification/run-live-verification.ts \
  --version 2.1.109 \
  --scenario minimal-hi \
  --plugin-command-template 'opencode run {prompt}' \
  --og-command-template 'claude --print {prompt}'
```

`{prompt}` is shell-escaped automatically.

## Output locations

- Sanitized reports: `manifests/reports/verification/`
- Verified overlays: `manifests/verified/claude-code/<version>.json`
- Verified index: `manifests/verified/claude-code/index.json`

The report contains:

- scenario pass/fail state
- sanitized capture summaries
- field-by-field OG vs plugin comparisons
- mismatch severity using the fingerprint risk classes

## Promotion rules in practice

Promotion is field-level.

A field is promoted only when all of this is true:

1. the scenario captured the field,
2. OG Claude Code and the plugin matched for that field,
3. the candidate manifest value also matches the live value.

If OG and plugin disagree, or the candidate value disagrees with the live value, the field is written to `rejectedCandidateFields` with the reason.

## Common failure modes

### Proxy startup fails

The runner uses `openssl` to create ephemeral certificates. If proxy setup fails, check that `openssl` is available and that the chosen port is free.

### No capture found

Usually one of these:

- the command never hit Anthropic,
- the prompt template did not match the scenario,
- the local command differs from the default template.

Start by overriding the command template explicitly.

### Scenario passes but nothing gets promoted

That means OG and plugin matched each other, but the candidate manifest still disagreed with the live value. The rejection entry tells you which path failed.

## Required verification after edits

For this phase, use:

```bash
bun run typecheck
bun scripts/verification/run-live-verification.ts --help
```

If you are testing the real live flow, run a single scenario first. `minimal-hi` is the safest smoke test.
