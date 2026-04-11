# Task 39 Evidence: Manual QA scripts — qa-parallel.sh + rotation-test.js + mock-upstream.js

## Task Description

Wave 6 third: create `scripts/qa-parallel.sh` for manual 50-concurrent-request validation, `scripts/mock-upstream.js` for local Anthropic SSE mocking, and `scripts/rotation-test.js` for OAuth token rotation dedup validation. These scripts enable end-to-end manual QA without touching real Anthropic endpoints. Includes a short README/CHANGELOG note pointing to them.

## Commit

`d1353ab` — `test(qa): scripts/qa-parallel.sh + rotation-test.js + mock-upstream.js for manual verification`

## Files Modified

- `scripts/qa-parallel.sh` (+245 lines — new)
- `scripts/mock-upstream.js` (+190 lines — new)
- `scripts/rotation-test.js` (+284 lines — new)
- `README.md` (2 lines — point users to `bash scripts/qa-parallel.sh`)
- `CHANGELOG.md` (1 line — note under v0.1.0 Added section)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+74 lines — script architecture learnings)
- `.sisyphus/notepads/quality-refactor/decisions.md` (1 line — cross-reference)

## Implementation Summary

### scripts/mock-upstream.js

A local HTTP server that pretends to be `api.anthropic.com`:

- Binds to a kernel-assigned port (printed on stdout as `MOCK_UPSTREAM_PORT=<n>`)
- Handles `POST /v1/messages` by emitting complete SSE event blocks with monotonic `toolu_<n>` tool_use IDs per request (so parallel tests can verify distinct responses)
- Emits `message_start`, `content_block_start(text)`, `content_block_delta` × N, `content_block_stop`, `message_delta`, `message_stop` — the happy path
- Optionally simulates truncated streams (no `message_stop`) via query param for testing T23/T27 error propagation
- Writes its access log to stderr (captured by qa-parallel.sh for evidence)

### scripts/qa-parallel.sh

The main manual QA script. Steps:

1. Start `scripts/mock-upstream.js` in background, capture its port
2. Build `dist/bun-proxy.mjs` via `bun x esbuild src/bun-proxy.ts` (the main build doesn't emit this; the script side-builds on demand)
3. Start the bun proxy with `--parent-pid=$$`, capture its port from the banner
4. Set `HTTP_PROXY=http://127.0.0.1:<mock-port>` so the proxy forwards to the mock upstream without touching real Anthropic
5. Fire 50 concurrent requests using `xargs -P 50 curl`, each with `x-proxy-url: http://api.anthropic.com/v1/messages` header so the proxy has a forwarding target
6. Collect results: count success / orphan / connect_error
7. Kill the parent shell process and verify the bun-proxy child exits within 10s (parent-PID watcher test — BPSP-1)
8. Cleanup: kill mock upstream, remove temp files
9. Report: `PASS` if 50/50 succeeded with 0 orphans AND the child exited on parent death, else `FAIL`

The script uses a sandbox-aware path convention: if `workdir` is a git sandbox, evidence files are written to absolute paths under the main repo's `.sisyphus/evidence/` so they survive sandbox cleanup (learned during F3).

### scripts/rotation-test.js

OAuth token rotation dedup validation. Steps:

1. Start a local token server that accepts `POST /v1/oauth/token` and always returns a rotated refresh_token on each call
2. Write a fake `anthropic-accounts.json` with 2 OAuth identities
3. Run the plugin's refresh flow 10 times per identity (20 total rotations)
4. Assert that `.accounts.length === 2` after all rotations complete
5. If the count is > 2, dedup is broken (identity-first logic failed)
6. Stubs `globalThis.fetch` to route `platform.claude.com/v1/oauth/token` to the local token server — no real network calls

## Test Results

Recorded in `.sisyphus/evidence/final-qa/f3-phase3-qa-parallel-run-*.txt`:

- **Run 1**: PASS (50/50 success, 0 orphans, 0 connect_errors, parent_death_ok=Y)
- **Run 2**: PASS (50/50 success, 0 orphans, 0 connect_errors, parent_death_ok=Y)
- **Run 3**: PASS (50/50 success, 0 orphans, 0 connect_errors, parent_death_ok=Y)

Also recorded in `.sisyphus/evidence/task-41-qa-parallel.txt`:

```
qa-parallel.sh: PASS (50/50, parent_death_ok=Y)
```

Rotation test results in `.sisyphus/evidence/final-qa/f3-phase5-rotation.txt`:

```
rotation-test.js: PASS (ACCOUNT_COUNT=2 after 20 rotations)
```

## Verification

- [x] `scripts/qa-parallel.sh` exists and is executable
- [x] `scripts/mock-upstream.js` exists
- [x] `scripts/rotation-test.js` exists
- [x] qa-parallel.sh passes 50/50 with 0 orphans
- [x] Parent-death watcher verified via qa-parallel.sh
- [x] rotation-test.js passes with ACCOUNT_COUNT=2 after 20 rotations
- [x] No real network calls in any script
- [x] README updated with pointer to qa-parallel.sh
- [x] CHANGELOG updated under v0.1.0 Added section

## Status

COMPLETE — evidence covered by commit `d1353ab`, 3× F3 manual QA runs (all PASS), and T41 final regression. F2 lint review flagged a regression: the two new JS scripts use CommonJS `require()` which the global eslint config forbids via `@typescript-eslint/no-require-imports`. This is queued for the Final Verification Wave fix-up and is NOT a functional T39 issue — the scripts execute correctly under Node.
