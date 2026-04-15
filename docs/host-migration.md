# Trusted verifier host migration

This is the cutover guide for moving the Phase 4 verifier off the current machine and onto an always-on host. The goal is boring: same commands, same manifests, different box.

## Prerequisites

Before you move anything, make sure the new host already has:

- Bun in `PATH`
- Node.js in `PATH`
- `openssl` available for the MITM certificate bootstrap used by `run-live-verification.ts`
- OG Claude Code installed and authenticated on the host
- the plugin/OpenCode command installed in the exact shape you want to verify
- access to this repository checkout, including `manifests/` and `scripts/verification/`
- permission to write persistent artifacts under `manifests/reports/verification/`

If the host will run unattended, also make sure it has whatever local auth context your verification scenarios expect. The scheduled wrapper does not create or repair OAuth state for you.

## Installation

1. Clone the repo on the new host.
2. Install dependencies:

    ```bash
    bun install
    ```

3. Confirm the verification tools are callable:

    ```bash
    bun scripts/verification/run-live-verification.ts --help
    bun scripts/verification/promote-verified.ts --help
    bun scripts/verification/promotion-cli.ts --help
    bash scripts/verification/run-scheduled-verifier.sh --help
    ```

4. Install or link the plugin/OpenCode build you want to compare against.
5. Authenticate OG Claude Code on the new host.

## Configuration changes

The migration should be configuration-only. These are the knobs the scheduled wrapper respects:

| Variable                           | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `VERIFIER_RUN_LABEL`               | Label written into reports, bundles, and PR text             |
| `VERIFIER_CANDIDATE_INDEX`         | Override candidate `index.json` path                         |
| `VERIFIER_CANDIDATE_DIR`           | Candidate manifest directory                                 |
| `VERIFIER_VERIFIED_DIR`            | Verified manifest directory                                  |
| `VERIFIER_ARTIFACT_ROOT`           | Persistent output root for scheduled runs                    |
| `VERIFIER_OG_COMMAND_TEMPLATE`     | Custom OG Claude Code command template                       |
| `VERIFIER_PLUGIN_COMMAND_TEMPLATE` | Custom plugin/OpenCode command template                      |
| `VERIFIER_PROXY_PORT`              | Fixed proxy port when ephemeral ports are not allowed        |
| `BUN_BIN` / `NODE_BIN`             | Override executable names if the host uses nonstandard paths |

Minimal example:

```bash
export VERIFIER_RUN_LABEL=trusted-host-verifier
export VERIFIER_ARTIFACT_ROOT=/var/lib/opencode-anthropic-fix/verification
export VERIFIER_PROXY_PORT=9091
```

## Scheduler setup

The wrapper is one-shot. Run it from your scheduler once per interval.

### systemd timer

Use this when the host is Linux and always on.

Service unit:

```ini
[Unit]
Description=Run the fingerprint verifier

[Service]
Type=oneshot
WorkingDirectory=/srv/opencode-anthropic-fix
Environment=VERIFIER_RUN_LABEL=trusted-host-verifier
Environment=VERIFIER_ARTIFACT_ROOT=/var/lib/opencode-anthropic-fix/verification
ExecStart=/bin/bash /srv/opencode-anthropic-fix/scripts/verification/run-scheduled-verifier.sh
```

Timer unit:

```ini
[Unit]
Description=Schedule the fingerprint verifier

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

### cron

Use cron when you want the simplest possible scheduler:

```cron
15 * * * * cd /srv/opencode-anthropic-fix && /bin/bash scripts/verification/run-scheduled-verifier.sh >> /var/log/fingerprint-verifier.log 2>&1
```

### LaunchAgent

If the always-on host is another macOS box, the same script works from `launchd`. Point `ProgramArguments` at `/bin/bash` plus `scripts/verification/run-scheduled-verifier.sh`, then set the environment variables in `EnvironmentVariables`.

## Testing the migration

Start with a manual smoke test before you trust the scheduler:

```bash
bash scripts/verification/run-scheduled-verifier.sh --once
```

Check the run directory it prints in `run.log`. A healthy run leaves behind:

- `verification-report.json`
- `promotion-result.json`
- `promotion-bundle.json`
- `fingerprint_verified.md`
- `run-summary.json`

Then verify the scheduler path:

1. trigger one scheduled run
2. confirm the run completed without a stale `.lock` directory
3. inspect `run-summary.json`
4. confirm `manifests/verified/claude-code/` updated only when approved fields existed

## Rollback

If the new host misbehaves, keep the rollback boring too:

1. disable the scheduler on the new host
2. remove any host-specific environment overrides
3. switch the old machine back on with the same wrapper
4. compare the last good artifact directories from both hosts before merging any PRs

Nothing in this migration requires schema changes or runtime rewrites. If rollback needs code changes, the migration drifted from the plan.
