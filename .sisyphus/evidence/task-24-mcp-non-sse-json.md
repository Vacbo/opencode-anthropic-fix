# Task 24 Evidence: Non-SSE JSON path for tool name de-prefixing

## Task Description

GREEN: Add a non-SSE JSON path to `src/response/mcp.ts` so tool name de-prefixing works for `application/json` responses, not just `text/event-stream`. Addresses SSE-14 finding: non-SSE JSON responses were not being de-prefixed, causing `mcp_mcp_...` drift on retry paths.

## Commit

`9da569f` — `fix(mcp): add non-SSE JSON path for tool name de-prefixing`

## Files Modified

- `src/response/mcp.ts` (91 lines modified)
- `src/response/index.ts` (2 lines — wire new path)
- `src/index.ts` (25 lines — route JSON responses through new path)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

The previous implementation only stripped `mcp_` prefixes in SSE event blocks. For non-streaming responses (count*tokens endpoint, retries that fall back to non-streaming mode, non-SSE error responses), `tool_use.name` kept its `mcp*`prefix, and on the next outbound request the body transformer unconditionally re-prefixed, producing`mcp*mcp*...` drift.

The fix adds a dedicated `stripMcpPrefixFromParsedJson` helper that:

1. Detects `content-type: application/json` responses
2. Parses the body once
3. Walks `messages[].content[].name` for assistant `tool_use` blocks
4. Strips the `mcp_` prefix exactly once if present
5. Returns a new `Response` with the rewritten body and original headers (minus `content-length`, recomputed)

The streaming path in `src/response/streaming.ts` (T23) already handles the SSE case; the two paths share the same `stripMcpPrefixFromParsedEvent` predicate to avoid drift.

## Test Results

- `npx vitest run src/response/streaming.test.ts -t "non-SSE"` — SSE-14 test passes (non-SSE JSON response is NOT wrapped in SSE transform AND its `mcp_` prefix is still stripped)
- `npx vitest run src/request/body.history.test.ts` — T16 TOOL-2 double-prefix defense tests pass (defense in depth: body.ts also guards, but mcp.ts prevents the drift from landing in the conversation history in the first place)
- T41 full regression: 903/903 passing

## Verification

- [x] `src/response/mcp.ts` has a non-SSE JSON path
- [x] `application/json` responses route through the new path
- [x] `text/event-stream` responses still route through `streaming.ts`
- [x] SSE-14 test from T13 suite passes
- [x] TOOL-2 double-prefix defense tests pass
- [x] No `mcp_mcp_...` drift observable in full suite

## Status

COMPLETE — evidence covered by commit `9da569f` and T41 regression.
