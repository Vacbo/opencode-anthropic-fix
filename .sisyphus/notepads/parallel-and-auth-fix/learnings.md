
## Task 0: Baseline Capture (2025-04-10)

### Completed
- Captured git SHA: c4b557db7c525f70f2494cd6b0e1ab76376b4e28
- Ran all baseline checks and saved evidence to `.sisyphus/evidence/`
- Created summary markdown at `.sisyphus/evidence/task-0-baseline.md`
- Committed with: `chore(plan): capture baseline state before parallel-and-auth-fix plan`

### Baseline State Summary
| Check | Status | Count |
|-------|--------|-------|
| Tests (Vitest) | ❌ FAIL | 3 failed, 660 passed |
| TypeScript | ❌ FAIL | 1 error |
| Lint (ESLint) | ✅ PASS | 0 errors |
| Format (Prettier) | ⚠️ WARN | 1 file |
| Build | ✅ PASS | 2 outputs |

### Key Issues Identified
1. **3 failing tests** related to account usage toast and fingerprint regression
2. **1 TypeScript error** in src/request/body.ts (line 57, argument count mismatch)
3. **1 formatting issue** in decisions.md file

### Evidence Files Created
- task-0-baseline-sha.txt
- task-0-baseline-vitest.txt
- task-0-baseline-tsc.txt
- task-0-baseline-lint.txt
- task-0-baseline-format.txt
- task-0-baseline-build.txt
- task-0-baseline.md (summary)

## Task 3: Deferred Helper (2025-04-10)

### Completed
- Created `src/__tests__/helpers/deferred.ts` with:
  - `createDeferred<T>()`: returns `{ promise, resolve, reject, settled }`
  - `createDeferredQueue<T>()`: returns `{ enqueue, resolveNext, rejectNext, pending }` FIFO queue
  - `nextTick()`: await 1 microtask
- Created smoke test with 12 passing tests
- Updated `vitest.config.ts` to exclude helper implementation files from test discovery
- Committed: `test(infra): add deferred helper for controllable promise races`

### Key Implementation Details
- Deferred promises track settled state to prevent double-resolve/reject
- Queue maintains FIFO order for predictable test sequencing
- nextTick uses `Promise.resolve()` for microtask scheduling (no fake timers)
- All rejections are propagated (no swallowing)

### Pattern Reference
Based on Node 22+ `Promise.withResolvers()` pattern with added settled tracking.

## Task 7: Vitest Config Update (2025-04-10)

### Completed
- Created `vitest.config.ts` with helper test globs registered
- Configuration includes both `src/**/*.test.ts` and `src/__tests__/helpers/**/*.test.ts`
- Excludes utility modules (non-test files) to prevent "No test suite found" errors
- Helper smoke tests now discovered and executed:
  - deferred.smoke.test.ts (12 tests)
  - in-memory-storage.smoke.test.ts (13 tests)
  - sse.smoke.test.ts (30 tests)
  - conversation-history.smoke.test.ts (created during test run)

### Key Pattern
When registering helper globs in vitest:
1. Include `**/*.test.ts` pattern for test files
2. Exclude utility modules that don't contain tests
3. This prevents false "No test suite found" failures

### Wave 1 Status
All T0-T7 tasks complete. 20/22 test files passing (2 pre-existing failures).
Ready for Wave 2 (T8-T16).
