# Task 38 Evidence: CHANGELOG v0.1.0 entry + package.json version bump

## Task Description

Wave 6 second: create `CHANGELOG.md` (first entry) documenting the v0.1.0 release covering all fixes and changes from Waves 1-5 — the parallel-request fix, SSE streaming rewrite, and account-dedup identity-first refactor. Bump `package.json` version from `0.0.37` to `0.1.0` to signal a meaningful behavioral release.

## Commit

`ca3ea53` — `docs(changelog): v0.1.0 entry for parallel-request and account-dedup fix`

## Files Modified

- `CHANGELOG.md` (+38 lines — new file with keep-a-changelog format)
- `package.json` (2 lines — version bump `0.0.37` → `0.1.0`)

## Implementation Summary

### CHANGELOG.md

New file following the [keep-a-changelog](https://keepachangelog.com/en/1.1.0/) format. The v0.1.0 entry has four sections:

**Fixed** (user-facing bug fixes):

- Parallel subagent failures (the `tool_use` orphan error reported by the user)
- SSE streaming fragility ("Unable to connect" errors under parallel F1-F4 review wave)
- Duplicate account creation on token rotation (for both OAuth and CC accounts)
- 55+ inventoried bugs related to race conditions and concurrent access

**Changed** (architectural improvements):

- Per-instance proxy lifecycle (replaces global shared proxy)
- Widened refresh lock constants (`timeoutMs` 2s → 15s, `staleMs` 20s → 90s)
- SSE event-framing rewrite with `message_stop` terminal validation
- Identity-based account dedup strategy (email / source+label instead of refresh token)

**Added** (new modules and test coverage):

- Account identity abstraction (`src/account-identity.ts`)
- Circuit breaker for per-request isolation (`src/circuit-breaker.ts`)
- Parent PID watcher for cross-platform death detection (`src/parent-pid-watcher.ts`)
- 10 new test files for parallel and dedup scenarios (+240 tests total)

**Removed** (obsolete mechanisms):

- Global health check failure counter (`healthCheckFails`)
- Fixed port `48372` (now ephemeral)
- Global PID file (now per-instance)
- Global process event handlers (`uncaughtException`, `unhandledRejection`)

All entries are written in user-facing language. Internal bug IDs (BP-1, SSE-3, DEDUP-A) are omitted from the user-facing log; they live in the plan and evidence files.

### package.json

```diff
-  "version": "0.0.37",
+  "version": "0.1.0",
```

The jump from `0.0.37` to `0.1.0` signals that this is a meaningful minor release (not a patch): the proxy lifecycle model changed, account dedup semantics changed, and the minimum-viable behavior contract for parallel sub-agents is now different. Users upgrading should read the CHANGELOG.

## Test Results

- `npm run format:check` — PASS for CHANGELOG.md and package.json
- Pre-existing format issue in `.sisyphus/notepads/quality-refactor/decisions.md` is unrelated to T38
- `npm run build` — PASS (version bump doesn't affect build)
- T41 full regression: 903/903 passing

## Verification

- [x] `CHANGELOG.md` exists at repo root
- [x] Keep-a-changelog format with Fixed/Changed/Added/Removed sections
- [x] All entries user-facing (no internal bug IDs)
- [x] `package.json` version bumped to `0.1.0`
- [x] `npm run format:check` clean
- [x] All Wave 1-5 work represented in the changelog

## Status

COMPLETE — evidence covered by commit `ca3ea53`. F4 scope audit confirmed this is the ONLY task whose file scope matched cleanly (touching CHANGELOG.md and package.json exclusively).
