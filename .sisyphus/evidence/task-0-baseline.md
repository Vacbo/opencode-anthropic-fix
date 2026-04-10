# Task 0: Baseline State Capture

**Plan:** parallel-and-auth-fix  
**Captured:** 2025-04-10 16:43 UTC  
**Git SHA:** c4b557db7c525f70f2494cd6b0e1ab76376b4e28

## Summary Table

| Check             | Status  | Count                | Details                                                            |
| ----------------- | ------- | -------------------- | ------------------------------------------------------------------ |
| Tests (Vitest)    | ❌ FAIL | 3 failed, 660 passed | 663 total tests, 20 test files                                     |
| TypeScript        | ❌ FAIL | 1 error              | src/request/body.ts:57                                             |
| Lint (ESLint)     | ✅ PASS | 0 errors             | Clean                                                              |
| Format (Prettier) | ⚠️ WARN | 1 file               | .sisyphus/notepads/quality-refactor/decisions.md                   |
| Build             | ✅ PASS | 2 outputs            | opencode-anthropic-auth-cli.mjs, opencode-anthropic-auth-plugin.js |

## Failed Tests Details

### 1. index.test.ts - fetch interceptor

- `does not show account usage toast for non-message endpoints`
- `does not repeat toast when account stays the same`

### 2. src/**tests**/fingerprint-regression.test.ts

- `appends version hash derived from first user message` (CC 2.1.98 billing header)

## TypeScript Error

```
src/request/body.ts(57,7): error TS2554: Expected 3 arguments, but got 4.
```

## Evidence Files

- `task-0-baseline-sha.txt` - Git commit SHA
- `task-0-baseline-vitest.txt` - Full test output
- `task-0-baseline-tsc.txt` - TypeScript errors
- `task-0-baseline-lint.txt` - ESLint output
- `task-0-baseline-format.txt` - Prettier check output
- `task-0-baseline-build.txt` - Build output + dist listing

## Notes

This baseline captures the state BEFORE any changes for the parallel-and-auth-fix plan. All subsequent tasks should reference this baseline to verify improvements.
