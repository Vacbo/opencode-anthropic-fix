# Task 27 Evidence: Stream-completeness error propagation

## Task Description

GREEN: Propagate stream-completeness errors from the SSE wrapper (T23) to the consumer. When an upstream stream closes without a `message_stop` event and without an `event: error`, surface a clear error to the calling code instead of silently emitting truncated output. This is the mechanism that prevents the `tool_use` orphan error from reaching the user as a confusing Anthropic API error.

## Commit

`e19463e` — `feat(streaming): propagate stream-completeness errors to consumer`

## Files Modified

- `src/response/streaming.ts` (+121 lines of propagation plumbing on top of T23's rewrite)
- `src/response/streaming.test.ts` (+30 lines — asserting error surfaces)
- `src/index.ts` (+20 lines — consumer wiring)

## Implementation Summary

T23 introduced terminal-event tracking in the SSE wrapper: a `sawTerminalEvent` boolean that flips when `message_stop` or `event: error` is parsed. T27 adds the machinery to turn an unset flag at EOF into an actionable error at the consumer boundary:

1. **Error type** — introduced `StreamCompletenessError` with `code: "STREAM_INCOMPLETE"`, `upstreamEOF: true`, and a message that names the unclosed block (`content_block_start(tool_use)` most commonly). This is a typed error so consumers can catch and rotate accounts or retry.

2. **Propagation path** — when the wrapper's `TransformStream.flush` runs at EOF without having seen a terminal event, it enqueues an error via `controller.error(new StreamCompletenessError(...))` instead of finishing cleanly. Downstream readers see a rejected promise from `reader.read()` and can act on it.

3. **Consumer handling in `src/index.ts`** — the fetch interceptor catches `StreamCompletenessError`, marks the current account as having had a transient failure (without a rate-limit penalty), and surfaces a clear error message to OpenCode. This prevents the downstream tool_use orphan error from reaching the model.

4. **Mid-stream error isolation** — when an `event: error` arrives mid-stream, the wrapper sets `sawTerminalEvent = true` so EOF after that error is NOT reported as incomplete (the error itself is the terminator).

5. **Test coverage** — T13 STREAM-COMPLETENESS test goes GREEN here, plus 3 new edge cases:
   - Stream with `content_block_start(tool_use)` but no `content_block_stop` → error surfaces
   - Stream with `message_start` but no `message_stop` → error surfaces
   - Clean stream with `message_stop` → no error, transparent pass-through

## Test Results

- `npx vitest run src/response/streaming.test.ts -t "STREAM-COMPLETENESS"` — PASS
- `npx vitest run src/response/streaming.test.ts` — all 14+3 tests PASS (14 from T13 + 3 new)
- `npx vitest run index.test.ts -t "stream abort"` — consumer correctly surfaces error and rotates
- T41 full regression: 903/903 passing

## Verification

- [x] `StreamCompletenessError` type defined and exported
- [x] SSE wrapper rejects reader on unset terminal flag at EOF
- [x] `index.ts` consumer catches and surfaces the error
- [x] Mid-stream `event: error` does NOT trigger the completeness check
- [x] Clean `message_stop` does NOT trigger the completeness check
- [x] T13 SSE-5 and STREAM-COMPLETENESS tests GREEN

## Status

COMPLETE — evidence covered by commit `e19463e`, builds on T23 (ab13c5c), covered in T41 regression.
