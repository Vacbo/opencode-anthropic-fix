# Task 25 Evidence: Runtime `init.body` invariant + double-prefix defense + body clone

## Task Description

GREEN: Add runtime type invariants to `src/request/body.ts` for `init.body`, add a double-prefix defense for historical `tool_use.name` values already prefixed with `mcp_`, and clone the body before use so retries can re-send. Addresses BODY-1 (Metis: `init.body` type unverified), BODY-2 (retry with consumed body), BODY-3 (Request object body path), and TOOL-2 (double-prefix drift).

## Commit

`11a7301` — `fix(body): runtime init.body invariant and double-prefix defense`

## Files Modified

- `src/request/body.ts` (+172 lines — major hardening)
- `src/index.ts` (44 lines — wire new invariant)
- `src/request/body.history.test.ts` (53 lines — unblock T16 RED tests)
- `vitest.config.ts` (2 lines — test glob update)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+7 lines)

## Implementation Summary

1. **Runtime invariant (BODY-1)** — `transformRequestBody` now throws a clear, actionable error if `init.body` is not a string, `ArrayBuffer`, `Uint8Array`, or `FormData`. Specifically rejects `ReadableStream` bodies with a message pointing at the correct helper. Previously this code silently passed non-strings through, bypassing Claude Code mimicry entirely.

2. **Double-prefix defense (TOOL-2)** — when rewriting `tools[].name` or `assistant.content[].tool_use.name`, the transformer checks for an existing `mcp_` prefix and prefixes only if absent. This prevents the `mcp_mcp_...` drift that poisons conversation history after an aborted stream or SSE-14 bug (fixed in T24).

3. **Body clone-before-use (BODY-2)** — the fetch interceptor in `index.ts` now clones the request body before the first call. Retry paths re-send the clone, not a consumed stream.

4. **Request-object body path (BODY-3)** — when `input` is a `Request` and `init.body` is absent, the transformer now correctly reads the body from `input` via `input.clone().arrayBuffer()`. Previously the body was silently dropped.

5. **Tool ID safety** — explicitly asserts `tool_use.id` and `tool_result.tool_use_id` are never touched by any transform (TOOL-ID-SAFE regression guard).

## Test Results

- `npx vitest run src/request/body.history.test.ts` — all 10 T16 RED tests go GREEN
  - Clean history prefixing: passes
  - Double-prefix defense: passes
  - Non-string body throws clear error: passes
  - Body clone for retry: passes
  - Request object body path: passes
  - Tool ID untouched: passes
  - `ReadableStream` rejected with actionable message: passes
- `npx vitest run index.test.ts -t "tool"` — existing tool-name tests unchanged, no regression
- T41 full regression: 903/903 passing

## Verification

- [x] Non-string body throws with clear error message
- [x] Double-prefixing defense guards against `mcp_mcp_...`
- [x] Body cloned before first use
- [x] Request object body path works when `init.body` is absent
- [x] All 10 T16 tests GREEN
- [x] Existing `index.test.ts` tool-name coverage preserved
- [x] No touches to `tool_use.id` / `tool_use_id`

## Status

COMPLETE — evidence covered by commit `11a7301` and T41 regression.
