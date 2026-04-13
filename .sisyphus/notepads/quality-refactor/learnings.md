

## Task 14: Clean up duplication and dead seams

### Duplication Found and Removed

**cmdStats function duplication**: Two nearly identical implementations existed:
- `src/cli/commands/auth.ts` (lines 772-849) - kept as canonical version
- `src/cli/commands/config.ts` (lines 197-276) - removed

Both displayed per-account usage statistics with identical table formatting. The config.ts version was only used internally by `dispatchUsageCommands`, making it safe to replace with an import from auth.ts.

**Changes made**:
1. Added import: `import { cmdStats } from "./auth.js";` to config.ts
2. Removed ~80 lines of duplicate code from config.ts
3. Removed unused imports (`fmtTokens`, `formatTimeAgo`, `rpad`) that were only used by the duplicate

### Intentional Duplication Preserved

**stripAnsi**: As noted in Task 5, the minimal duplication (3 lines) between `src/cli/formatting.ts` and `src/commands/router.ts` is intentional. Both modules should remain self-contained for their respective contexts.

### Dead Seams Analysis

No dead transitional wrappers or orphaned code were found in the touched hotspot modules. The refactor extraction was clean - all re-exports are actively used by tests and external consumers.

### Verification

- `npm run lint`: 0 errors (42 pre-existing console warnings)
- `npx tsc --noEmit`: No type errors
- No behavior changes - function implementation is identical

### Pattern for Future Refactors

When extracting code into sub-modules:
1. Check for duplicate implementations that may have been created during incremental extraction
2. Keep the version that's more publicly accessible (re-exported from facade modules)
3. Remove unused imports exposed by the cleanup
4. Verify all re-exports are still needed by running tests

### Evidence Saved

- `.sisyphus/evidence/task-14-duplication.txt`: Detailed duplication report
- `.sisyphus/evidence/task-14-dead-seams.txt`: Dead seams analysis
