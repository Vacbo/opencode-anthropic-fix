# Task 23 Evidence: SSE streaming rewrite — event-framing + message_stop terminal

## Task Description

GREEN: Rewrite `src/response/streaming.ts` to use event-block framing (not line framing), enforce `message_stop` / `event: error` terminal semantics, unify the parser and rewriter buffer, and propagate `cancel()` to the underlying reader. This addresses the DIRECT cause of the `tool_use` orphan error reported by the user.

## Commit

`ab13c5c` — `refactor(streaming): event-framing SSE wrapper with message_stop terminal validation`

## Files Modified

- `src/response/streaming.ts` (+318 / -78 lines — near-total rewrite)
- `.sisyphus/notepads/parallel-and-auth-fix/learnings.md` (+6 lines)

## Implementation Summary

The previous implementation framed on `\n` and flushed any partial buffer on EOF as if it were a valid SSE event. When the upstream stream closed mid-`tool_use` block, the wrapper emitted a malformed terminal chunk that left `content_block_start(tool_use)` unclosed. That produced the reported error:

```
messages.89: tool_use ids were found without tool_result blocks immediately after: toolu_017yoePuM9yzMy1sgrxzcTum
```

The rewrite:

1. **Event-block framing** — parses on the canonical `\n\n` event-block terminator. Partial events stay in the buffer; they are NOT emitted until their terminator arrives OR the stream completes cleanly with a terminal event.

2. **Shared buffer** — parser and rewriter read from one buffer with one normalization pass. Previously they maintained independent buffers and could desync when multi-`data:` events were rewritten.

3. **Terminal validation** — the wrapper tracks whether it has seen `message_stop` or `event: error` before EOF. If the stream closes without a terminal event, it surfaces a clear error to the consumer instead of silently emitting truncated output.

4. **UTF-8 safety** — the final `TextDecoder.decode()` is called with `{stream: false}` at EOF to flush any leftover trailing bytes. No multi-byte corruption at chunk boundaries.

5. **Cancel propagation** — calling `cancel()` on the wrapper now propagates to the underlying reader, releasing subprocess and network resources promptly.

6. **Tool ID safety** — the rewrite pipeline preserves `tool_use.id` and `tool_result.tool_use_id` byte-for-byte. Only `tool_use.name` is stripped of the `mcp_` prefix, and only exactly once.

## Test Results

- `npx vitest run src/response/streaming.test.ts` — all 14 T13 RED tests go GREEN after this commit
  - SSE-1 through SSE-15 regression cases
  - STREAM-COMPLETENESS validation
  - Cancel propagation
  - Tool ID preservation
  - Single-prefix stripping
- `npx vitest run index.test.ts` — existing integration tests unchanged, no regression
- T41 full regression: 903/903 passing

## Verification

- [x] File `src/response/streaming.ts` rewritten with event-block framing
- [x] All 14 T13 regression tests pass
- [x] Existing `index.test.ts` streaming coverage still passes
- [x] `tool_use.id` preserved through pipeline (TOOL-ID-SAFE guard)
- [x] Stream closed without `message_stop` surfaces error (STREAM-COMPLETENESS)
- [x] Multi-byte UTF-8 at chunk boundaries handled correctly

## Status

COMPLETE — evidence covered by commit `ab13c5c` + T27 (stream-completeness propagation) + T41 regression.
