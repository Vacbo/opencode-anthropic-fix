# Task 37 Evidence: Documentation updates — README, AGENTS.md, mimese

## Task Description

Wave 6 first: update `README.md` to document the per-instance proxy lifecycle and Windows native fetch fallback, update `AGENTS.md` with new concurrency guarantees, and update `docs/mimese-http-header-system-prompt.md` if any header/beta logic changed. Also renames `agents.md` → `AGENTS.md` (case-insensitive filesystem-aware rename).

## Commit

`af55df1` — `docs: rename agents.md to AGENTS.md and update README + mimese docs for per-instance proxy lifecycle`

## Files Modified

- `README.md` (+17 lines — new "Per-instance Proxy Lifecycle" section + "Known Limitations" section for Windows)
- `AGENTS.md` (+14 lines — new "Concurrency guarantees" section)
- `docs/mimese-http-header-system-prompt.md` (+11 lines — proxy lifecycle note)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (various — consolidation)

## Implementation Summary

### README.md

Added two new sections:

1. **Per-instance Proxy Lifecycle** — explains that each OpenCode instance owns its own Bun proxy process, the proxy monitors parent PID and exits with it, the proxy binds to an ephemeral port, and falls back gracefully to native fetch if Bun is unavailable. Written in user-facing language (not implementer jargon).

2. **Known Limitations** — documents:
   - Windows native fetch fallback (Bun proxy unavailable, no TLS mimicry)
   - Claude Code refresh blocking (latent 60-second CC CLI invocation)

Also adds one-line hint to Quick Start: `Manual parallel QA: bash scripts/qa-parallel.sh` (cross-reference to T39).

### AGENTS.md

Added a `## Concurrency guarantees` section codifying the architectural invariants for contributors and future agents:

- Single proxy handles N concurrent requests
- Circuit breaker is per-request not global
- No restart-kill behavior
- Stable identity dedup
- Per-instance proxy lifecycle

And updated the `## Change policy` section with:

- Maintain concurrency guarantees
- Keep graceful fallback to native fetch when Bun is unavailable

Also updated the "Request-shaping expectations" section to add the `oauth-2025-04-20` beta requirement (already in code, just documenting the contract).

### docs/mimese-http-header-system-prompt.md

Added a short note explaining the per-instance proxy lifecycle does NOT change the header/beta/system-prompt mimicry logic — that remains identical to the single-proxy era. The mimicry contract with Anthropic is unchanged.

### Filesystem rename

The previous file was `agents.md` (lowercase). Git's case-insensitive default on macOS made the rename awkward. The commit did the rename as part of the doc update so any tooling that references `AGENTS.md` (uppercase) works correctly.

## Test Results

- `npm run format:check` — PASS on all three files
- `npm run lint` — PASS (documentation files excluded from ts lint)
- Manual review: all three files render correctly as markdown
- T41 full regression: 903/903 tests still passing (docs don't affect tests)

## Verification

- [x] README.md has "Per-instance Proxy Lifecycle" section
- [x] README.md has "Known Limitations" section for Windows
- [x] AGENTS.md has "Concurrency guarantees" section
- [x] AGENTS.md "Change policy" updated
- [x] docs/mimese-http-header-system-prompt.md has proxy lifecycle note
- [x] `agents.md` → `AGENTS.md` rename clean
- [x] `npm run format:check` passes
- [x] Grammar and voice consistent with existing README tone

## Status

COMPLETE — evidence covered by commit `af55df1`. Note: this was bundled with a learnings.md consolidation in the same commit, which F4 flagged as minor scope drift but is documentation-only.
