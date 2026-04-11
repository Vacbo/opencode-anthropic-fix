# Task 21 Evidence: Debug-gating test flip (atomic with T20)

## Task Description

GREEN: Remove global `process.on("uncaughtException")` and `process.on("unhandledRejection")` handlers from `src/bun-fetch.ts` and atomically update `src/__tests__/debug-gating.test.ts` assertions from `toContain` → `not.toContain` for `"uncaughtException"` and `"unhandledRejection"`.

Atomic with T20 per Metis review: the existing test at `src/__tests__/debug-gating.test.ts:33-39` asserts the PRESENCE of these handler strings in source. Removing the handlers without updating the test breaks the suite. Must land in the same commit.

## Commit

`f602847` — `fix(bun-fetch): per-instance proxy manager with circuit breaker integration`

Commit body explicitly notes: `Refs: T20, T21 (atomic commit)`.

## Files Modified

- `src/bun-fetch.ts` — removed `process.on("uncaughtException", ...)` and `process.on("unhandledRejection", ...)` handlers; removed `exitHandlerRegistered` module state that gated them.
- `src/__tests__/debug-gating.test.ts` — flipped `toContain("uncaughtException")` → `not.toContain("uncaughtException")` and same for `unhandledRejection`. Test header updated to reflect the new invariant.

## Implementation Summary

The T20 rewrite eliminated all module-level state in `bun-fetch.ts`. As part of that rewrite, the plugin no longer installs process-wide exception handlers — those handlers were the source of the restart-kill cascade and could clobber state belonging to unrelated OpenCode instances. T21 is the paired test update that makes the assertion match the new source.

The test now reads the source of `src/bun-fetch.ts` at runtime and asserts:

```ts
expect(source).not.toContain("uncaughtException");
expect(source).not.toContain("unhandledRejection");
```

This is a source-grep test, so it runs in < 5 ms and catches any regression that tries to re-introduce global handlers.

## Test Results

- `npx vitest run src/__tests__/debug-gating.test.ts` — PASS
- Full suite at T41 regression: 903/903 tests passing (see `.sisyphus/evidence/task-41-vitest.txt`)
- Guardrail grep at T41: `rg 'process\.on\s*\(\s*["'\'']uncaughtException' src/` returns 0 matches in runtime plugin code (see `.sisyphus/evidence/task-41-guardrails.txt`)

## Verification

- [x] Handlers removed from `src/bun-fetch.ts`
- [x] Test assertions flipped atomically in same commit
- [x] `debug-gating.test.ts` passes against new source
- [x] Guardrail grep clean at final regression gate (T41)
- [x] No other file re-introduces global handlers (verified across the plugin tree, excluding `bun-proxy.ts` subprocess which legitimately needs SIGTERM/SIGINT handling of its own process)

## Status

COMPLETE — evidence covered by commit `f602847` (atomic T20+T21 pair) and T41 final regression.
