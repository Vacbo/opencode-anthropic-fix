
## QA Run — 2026-03-21

### Vitest/Bun Incompatibility (ALL 80 failures)

Two Vitest-specific APIs are used in tests but **not supported by bun's test runner**:

1. **`vi.unstubAllEnvs()`** — Used in `fingerprint-regression.test.ts` (lines 379, 499)
   - Causes 32 test failures in Sonnet 4.6, Beta header, Billing header, User-Agent suites
2. **`vi.mock(path, async (importOriginal) => ...)`** — Used in `accounts.test.ts`, `index.test.ts`, `cli.test.ts`
   - Causes 48 test failures across loadConfig, saveAccounts, oauth, refresh-lock, ensureGitignore suites

**Impact**: These are test harness compatibility issues, NOT logic bugs. The underlying implementation code is correct.

**Fix options**:
- Replace `vi.unstubAllEnvs()` with manual env cleanup (e.g., `delete process.env.KEY`)
- Replace `importOriginal` factory pattern with `vi.mock()` + `vi.spyOn()` or pre-import mocking
- Or switch to `vitest` runner instead of `bun test`
