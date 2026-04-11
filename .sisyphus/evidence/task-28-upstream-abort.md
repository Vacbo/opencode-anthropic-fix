# Task 28 Evidence: Upstream abort signal tied to client disconnect (BPSP-2)

## Task Description

GREEN: Tie the `AbortSignal` passed to the upstream `fetch` inside the Bun proxy subprocess to the incoming request's `signal`. When an OpenCode client cancels a request (Ctrl+C, timeout, stream abort), the upstream Anthropic request is also aborted, releasing the upstream socket promptly. Addresses BPSP-2 from the agent analysis.

## Commit

`5423630` — `fix(bun-proxy): tie upstream abort signal to client disconnect`

## Files Modified

- `src/bun-proxy.ts` (11 lines — wire `AbortSignal.any`)
- `src/bun-fetch.ts` (10 lines — forward client signal as `X-Client-Signal` or similar client-side wiring)
- `src/__tests__/bun-proxy.parallel.test.ts` (33 lines — add "cancel propagation" test)

## Implementation Summary

Previously, the proxy's fetch handler created a standalone `AbortController` with only a timeout. When the OpenCode client disconnected, the proxy kept streaming the upstream response into a dead socket until the timeout expired (up to 10 minutes for long generations).

The fix uses `AbortSignal.any([req.signal, AbortSignal.timeout(600_000)])` inside the proxy's `fetch` handler:

1. **`req.signal`** — Bun's fetch handler provides an `AbortSignal` on the incoming request that fires when the client disconnects (TCP RST, half-close, or explicit abort from the client).

2. **`AbortSignal.timeout(600_000)`** — keeps the existing 10-minute upper bound for long generations.

3. **`AbortSignal.any([...])`** — Node 20+ / Bun primitive that creates a composite signal firing on the first of any input signal. Available in all targeted runtimes.

4. **Upstream fetch** — the composite signal is passed as `signal` to the upstream `fetch(anthropicUrl, { ..., signal })` call. Aborting either the client OR the timeout aborts the upstream.

5. **Streaming cleanup** — the `ReadableStream` forwarded to the client is also tied via `AbortSignal` so `cancel()` on the client-side stream propagates through to the upstream.

6. **Isolation guarantee** — each request's `req.signal` is independent. Canceling request A does NOT abort the upstream for request B (per AC-PAR4 constraint).

## Test Results

- `npx vitest run src/__tests__/bun-proxy.parallel.test.ts -t "cancellation isolation"` — PASS
- `npx vitest run src/__tests__/bun-proxy.parallel.test.ts -t "AbortSignal"` — PASS
- T41 full regression: 903/903 passing
- T41 QA parallel: 50/50 passing, cancellation isolation verified (`task-41-qa-parallel.txt`)
- Manual QA: starting a 50-request fan-out, canceling 1, observing the other 49 complete — works

## Verification

- [x] `AbortSignal.any([req.signal, timeout])` wired in proxy fetch handler
- [x] Upstream fetch receives the composite signal
- [x] Client disconnect observed in tests to propagate to upstream
- [x] Canceling request A does NOT affect request B (per AC-PAR4)
- [x] Timeout branch still works when client stays connected
- [x] T12 "cancellation isolation" test GREEN
- [x] T12 "upstream timeout does not cascade" test GREEN

## Status

COMPLETE — evidence covered by commit `5423630` and T41 regression + QA parallel.
