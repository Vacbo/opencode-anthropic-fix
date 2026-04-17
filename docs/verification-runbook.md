# Trusted local verification runbook

This flow is for this machine. It assumes three things are already true:

1. OG Claude Code is installed and authenticated.
2. The plugin/OpenCode command you want to verify is installed locally.
3. You already generated a candidate manifest for the target version.

## What the runner does

The preferred flow is:

1. capture OG Claude Code and plugin traffic with the passive HTTPS MITM in `scripts/validation/proxy-capture.ts`,
2. save the raw request artifacts,
3. feed those artifacts into `scripts/verification/run-live-verification.ts` for offline comparison.

When Proxyman is already the known-good capture method on this machine, prefer the new Proxyman-backed wrapper instead of re-creating another capture layer.

`scripts/verification/run-live-verification.ts` can still drive commands directly, but that path is for debugging only. The primary verification workflow is offline comparison from saved captures.

It does **not** write raw bearer tokens or raw request bodies into the report.

`scripts/verification/promote-verified.ts` reads that report, checks candidate-manifest values against the live-verified values, and promotes only the fields that actually matched.

## Quick start

### Preferred when Proxyman is the trusted capture source

Requirements:

- Proxyman app is running
- Recording is enabled in Proxyman
- `proxyman-cli` is available at `/Applications/Proxyman.app/Contents/MacOS/proxyman-cli`

Run a complete OG-vs-plugin experiment for one scenario:

```bash
bun scripts/proxyman/run-scenario.ts \
  --version 2.1.109 \
  --scenario minimal-hi
```

This wrapper will:

1. clear the current Proxyman session,
2. run OG Claude Code through the Proxyman proxy,
3. export a HAR from Proxyman,
4. normalize the selected flow into the verifier's `CaptureRecord` format,
5. repeat for the plugin/OpenCode command,
6. invoke `scripts/verification/run-live-verification.ts` in offline mode.

Artifacts are written to `manifests/reports/proxyman/<scenario>-<timestamp>/`.

If you already exported a Proxyman HAR manually, normalize it directly:

```bash
bun scripts/proxyman/normalize-har.ts \
  --har /path/to/export.har \
  --scenario minimal-hi \
  --out /tmp/minimal-hi-capture.json
```

### Alternate local passive-proxy path

Capture the baseline scenario with the passive proxy:

```bash
bun scripts/validation/proxy-capture.ts
# Run the capture helper under Bun so the validation path keeps Claude Code's runtime/TLS shape.
# In another terminal, point OG Claude Code at the HTTPS proxy and run the scenario.
# Repeat separately for the plugin/OpenCode command.
```

Then compare the saved artifacts offline:

```bash
bun scripts/verification/run-live-verification.ts \
  --version 2.1.109 \
  --scenario minimal-hi \
  --og-capture /path/to/og-capture.json \
  --plugin-capture /path/to/plugin-capture.json \
  --report manifests/reports/verification/2.1.109-minimal-hi.json
```

Then promote the verified fields:

```bash
bun scripts/verification/promote-verified.ts \
  --version 2.1.109 \
  --report manifests/reports/verification/2.1.109-minimal-hi.json
```

## Scenario files

Scenario definitions live in `scripts/verification/scenarios/`.

- `minimal-hi.json` — baseline message request
- `tool-search.json` — tool registration and optional betas
- `append-system-prompt.json` — billing/identity block structure
- `oauth-token-refresh.json` — manual OAuth refresh validation

By default the runner skips `oauth-token-refresh` because a real refresh usually needs a custom command or a deliberately expired token.

## Command templates

If you explicitly use the live command-driving mode, the default commands are:

- OG Claude Code: `claude --bare --print {prompt}`
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

Start by using the passive proxy flow and offline `--og-capture` / `--plugin-capture` mode. Only fall back to command templates when debugging the runner itself.

### Scenario passes but nothing gets promoted

That means OG and plugin matched each other, but the candidate manifest still disagreed with the live value. The rejection entry tells you which path failed.

## Required verification after edits

For this phase, use:

```bash
bun run typecheck
bun scripts/verification/run-live-verification.ts --help
```

If you are testing the real live flow, run a single scenario first. `minimal-hi` is the safest smoke test. For normal verification, prefer passive capture + offline comparison.
