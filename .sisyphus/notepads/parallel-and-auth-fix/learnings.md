## Task 0: Baseline Capture (2025-04-10)

### Completed

- Captured git SHA: c4b557db7c525f70f2494cd6b0e1ab76376b4e28
- Ran all baseline checks and saved evidence to `.sisyphus/evidence/`
- Created summary markdown at `.sisyphus/evidence/task-0-baseline.md`
- Committed with: `chore(plan): capture baseline state before parallel-and-auth-fix plan`

### Baseline State Summary

| Check             | Status  | Count                |
| ----------------- | ------- | -------------------- |
| Tests (Vitest)    | ❌ FAIL | 3 failed, 660 passed |
| TypeScript        | ❌ FAIL | 1 error              |
| Lint (ESLint)     | ✅ PASS | 0 errors             |
| Format (Prettier) | ⚠️ WARN | 1 file               |
| Build             | ✅ PASS | 2 outputs            |

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

## Task 2: SSE Helper (2025-04-10)

### Completed

- Created `src/__tests__/helpers/sse.ts` with all required exports:
  - `encodeSSEEvent` - formats single SSE event with proper \n\n terminator
  - `encodeSSEStream` - joins N events into complete SSE stream
  - `chunkUtf8AtOffsets` - splits UTF-8 at byte offsets, handles multi-byte safely
  - `makeSSEResponse` - creates Response with text/event-stream content-type
  - `makeTruncatedSSEResponse` - emits N events then closes WITHOUT terminator
  - `makeMalformedSSEResponse` - creates malformed SSE response for error testing
  - Typed event factories: messageStartEvent, contentBlockStartEvent, contentBlockDeltaEvent,
    contentBlockStopEvent, messageDeltaEvent, messageStopEvent, errorEvent

- Created `src/__tests__/helpers/sse.smoke.test.ts` with 30 passing tests
- Verified multi-byte UTF-8 handling: chunkUtf8AtOffsets("café", [1,2,3]) correctly handles 2-byte 'é'

### Key Implementation Details

- UTF-8 chunking uses TextEncoder to get byte representation
- Multi-byte character boundaries detected by checking continuation bytes (0x80-0xBF)
- SSE events properly terminated with double newline (\n\n)
- Event factories return SSEEvent interface with JSON-stringified data

### Evidence

- `.sisyphus/evidence/task-2-sse-smoke.txt`
- All 30 smoke tests pass

## Task 4: In-Memory Storage Helper (2025-04-10)

### Completed

- Created `src/__tests__/helpers/in-memory-storage.ts` with:
  - `createInMemoryStorage(initial?)` - factory function
  - `InMemoryStorage` interface with `snapshot()`, `setSnapshot()`, `mutateDiskOnly()`
  - Mock functions `loadAccountsMock` and `saveAccountsMock` (vi.fn wrappers)
  - Helper functions `makeStoredAccount()` and `makeAccountsData()`
- Created smoke test with 13 test cases covering:
  - Initial state creation (with and without data)
  - Snapshot management and deep cloning
  - Disk mutation simulation (`mutateDiskOnly`)
  - Mock function behavior
- Evidence captured: `.sisyphus/evidence/task-4-inmem-smoke.txt`
- Committed: 9a89d5b (included with deferred helper commit)

### Key Design Decisions

1. **Dual-state model**: Separate `diskState` (simulates filesystem) and `memoryState` (simulates loaded in-memory copy)
2. **Deep cloning**: All returns use `structuredClone()` to prevent accidental mutations via references
3. **Concurrent simulation**: `mutateDiskOnly()` updates only disk state, leaving memory unchanged - simulates another process writing to disk
4. **Type safety**: Uses `AccountMetadata` and `AccountStorage` from storage.js

### Usage Pattern

```typescript
const storage = createInMemoryStorage(initialData);
vi.mock("../../storage.js", () => ({
  loadAccounts: storage.loadAccountsMock,
  saveAccounts: storage.saveAccountsMock,
  createDefaultStats: vi.fn(...),
}));
```

## Task 6: Conversation History Helper

Created: src/**tests**/helpers/conversation-history.ts

- Factory functions for Anthropic Messages API conversation state
- Exports: makeConversation, makeMessage, makeToolUse, makeToolResult, ConversationFactory
- Validation helpers: validateToolPair, findToolResult, validateConversationTools
- Convenience builders: makeToolExchange, makeToolConversation
- Unique ID generation with crypto.randomUUID()

Created: src/**tests**/helpers/conversation-history.smoke.test.ts

- 25 tests covering all factory functions
- Tool pairing validation tests
- Complex conversation scenario tests

Evidence: .sisyphus/evidence/task-6-conversation-smoke.txt

## Task 5: Mock Bun Proxy Helper (2026-04-10)

### Completed

- Added `src/__tests__/helpers/mock-bun-proxy.ts` as a ChildProcess-style DI harness for Bun proxy lifecycle tests.
- Added `src/__tests__/helpers/mock-bun-proxy.smoke.test.ts` covering banner emission, exit handling, spawn failure, and forwarded fetch concurrency.
- Saved smoke-test evidence to `.sisyphus/evidence/task-5-mockproxy-smoke.txt`.

### Learnings

- A realistic subprocess test harness only needs the ChildProcess surface the production code touches: `pid`, `stdout`/`stderr`, `kill`, `exit`, and `close`.
- `PassThrough` streams are a good fit for stdout/stderr test doubles because they preserve `data` event behavior without a real subprocess.
- Forwarded proxy-request tests stay deterministic by normalizing `x-proxy-url` into a shared mock fetch and counting in-flight requests inside the helper.
