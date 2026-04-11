# Lint Error Fixes - F2 Review

## Summary

Fixed 16 lint errors identified by F2 reviewer:

- 12 errors in scripts/ (CommonJS require() in ESM files)
- 4 errors in src/ (empty catch blocks)

## Changes Made

### 1. scripts/mock-upstream.js

- **Line 3**: Converted `const http = require("node:http")` to `import http from "node:http"`

### 2. scripts/rotation-test.js

- **Lines 3-7**: Converted all CommonJS requires to ESM imports:
  - `const fs = require("node:fs/promises")` → `import fs from "node:fs/promises"`
  - `const http = require("node:http")` → `import http from "node:http"`
  - `const os = require("node:os")` → `import os from "node:os"`
  - `const path = require("node:path")` → `import path from "node:path"`
  - `const { pathToFileURL } = require("node:url")` → `import { pathToFileURL } from "node:url"`

### 3. src/bun-fetch.ts

- **Line 371**: Added explanatory comment to empty catch block:
  ```typescript
  } catch {
    // Process may have already exited; ignore kill failures
  }
  ```

### 4. src/response/streaming.ts

- **Line 201**: Added explanatory comment:
  ```typescript
  } catch {
    // JSON parse failed; context will be returned without inFlightEvent
  }
  ```
- **Line 472**: Added explanatory comment:
  ```typescript
  } catch {
    // Error handler failed; continue with cleanup
  }
  ```
- **Line 477**: Added explanatory comment:
  ```typescript
  } catch {
    // Reader cancel failed; stream may already be closed
  }
  ```

## Verification

- `bun run lint`: 0 errors (was 16 errors)
- `bun run build`: Passes successfully
- All changes are minimal and focused on lint fixes only
- No logic changes made beyond fixing the lint errors

## Notes

The comments in catch blocks are necessary to satisfy the lint rule that prohibits empty catch blocks without justification. They explain why the errors are intentionally ignored in cleanup scenarios.

## F4 Scope Fidelity Rerun

- Rerun verdict stayed **REJECT**.
- Metis tripwires are still clean, so the blocker is scope discipline rather than forbidden-path edits.
- The branch still carries prior out-of-scope artifacts (cross-plan files, archive bundles, unrelated meta files, sacred plan edits).
- New issue on rerun: the committed F3 evidence filenames do not match the exact F3 filenames declared in the plan.
- Additional blocker: the worktree was dirty during rerun, including a direct modification to `.sisyphus/plans/parallel-and-auth-fix.md`.

---

## Fix: Dead Conditional in reportFallback (src/bun-fetch.ts lines 172-182)

**Date:** 2026-04-11
**Issue:** Both if/else branches executed identical `console.error(message)` - conditional was meaningless
**Fix Applied:** Option A - Removed the dead conditional entirely

### Before (buggy):

```typescript
const reportFallback = (reason: string, debugOverride?: boolean): void => {
  onProxyStatus?.(getStatus(reason, "fallback"));

  const message = `[opencode-anthropic-auth] Native fetch fallback engaged (${reason}); Bun proxy fingerprint mimicry disabled for this request`;
  if (resolveDebug(debugOverride)) {
    console.error(message);
    return;
  }

  console.error(message); // Identical to line 177!
};
```

### After (fixed):

```typescript
const reportFallback = (reason: string, _debugOverride?: boolean): void => {
  onProxyStatus?.(getStatus(reason, "fallback"));
  console.error(
    `[opencode-anthropic-auth] Native fetch fallback engaged (${reason}); Bun proxy fingerprint mimicry disabled for this request`,
  );
};
```

### Changes:

1. Removed dead conditional (if/else with identical behavior)
2. Prefixed unused `debugOverride` parameter with underscore (`_debugOverride`)
3. Inlined the message template directly into console.error
4. Simplified from 11 lines to 3 lines

### Verification:

- `bun run build` ✓ (exit 0)
- `bun run lint` ✓ (0 errors, 19 pre-existing warnings)

**Status:** F2 blocker resolved. Ready for approval.
