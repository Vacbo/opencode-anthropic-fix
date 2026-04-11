## Task 38: Changelog and Version Bump (2026-04-10)

### Completed

Created CHANGELOG.md with v0.1.0 entry documenting all fixes and changes from Waves 1-5:

**CHANGELOG.md created with keep-a-changelog format:**

- **Fixed section**: 4 user-facing bug fixes
  - Parallel subagent failures (tool_use orphan errors)
  - SSE streaming fragility (Unable to connect errors)
  - Duplicate account creation on token rotation
  - 55+ inventoried bugs related to race conditions

- **Changed section**: 4 architectural improvements
  - Per-instance proxy lifecycle (was global)
  - Widened refresh lock constants (15s timeout, 90s stale)
  - SSE event-framing rewrite
  - Identity-based account dedup strategy

- **Added section**: 4 new modules
  - Account identity abstraction
  - Circuit breaker for per-request isolation
  - Parent PID watcher for cross-platform death detection
  - 10 new test files for parallel and dedup scenarios

- **Removed section**: 4 obsolete mechanisms
  - Global health check failure counter
  - Fixed port 48372 (now ephemeral)
  - Global PID file (now per-instance)
  - Global process event handlers

**package.json updated:**

- Version bumped from 0.0.37 to 0.1.0
- Signals completion of parallel-request and account-deduplication fixes

### Verification

- `npm run format:check` passes for new files
- Pre-existing format issue in `.sisyphus/notepads/quality-refactor/decisions.md` is unrelated
- CHANGELOG.md follows keep-a-changelog format with proper sections
- All entries are user-facing (no internal bug IDs)

### Files Modified

- CHANGELOG.md (new file with v0.1.0 entry)
- package.json (version bump 0.0.37 → 0.1.0)

### Commit

`docs(changelog): v0.1.0 entry for parallel-request and account-dedup fix`

## Task 39: Manual QA Scripts (2026-04-11)

- `scripts/mock-upstream.js` uses a kernel-assigned port, emits complete SSE event blocks, and assigns monotonic `toolu_` IDs per request.
- `scripts/qa-parallel.sh` validates 50 concurrent proxy requests by routing Bun fetch traffic through the local mock upstream via `HTTP_PROXY`, which avoids touching real Anthropic endpoints while keeping the proxy hostname allowlist intact.
- `scripts/rotation-test.js` drives repeated OAuth token rotations through the built plugin against a local token server and confirms the persisted account count stays at 2.

## Task 40: Full Suite Gate Test Sweep (2026-04-11)

- `index.test.ts` now uses mutable mocked account storage in the cross-request failover cases because `syncActiveIndexFromDisk()` rehydrates state on each fetch and will wipe in-memory rate-limit/auth mutations unless `saveAccounts` feeds subsequent `loadAccounts` calls.
- Mid-stream failover assertions also need the debounced `requestSaveToDisk()` timer flushed before the next request; advancing timers by a little over 1 second makes the persisted failover state observable.
- Refresh mocks must be real `Response` objects now that the plugin inspects response headers/body helpers during token refresh and final response shaping.
- `plugin-fetch-harness` smoke tests are safer when mocked transport responses are real `Response` instances with JSON content-types instead of partial response-shaped objects.
- Billing-header fingerprint expectations must include the current version-suffix algorithm: missing characters are padded with `"0"` and the Claude CLI version participates in the hash input.
