## Task 37: Documentation Update (2026-04-10)

### Completed

Updated documentation to reflect per-instance proxy lifecycle and concurrency guarantees:

**README.md changes:**

- Added "Per-instance Proxy Lifecycle" section after Configuration, before "How It Works"
  - Documents each OpenCode instance owns its own proxy
  - Documents proxy dies with parent process
  - Documents ephemeral port allocation
  - Documents graceful fallback to native fetch
- Added "Known limitations" section before License
  - Documents Windows native fetch fallback (no mimicry)
  - Documents CC refresh blocking up to 60s (latent issue, out of scope)

**AGENTS.md changes:**

- Added "Concurrency guarantees" section after "Operating rules"
  - Documents single proxy handles N concurrent requests
  - Documents circuit breaker is per-request not global
  - Documents no restart-kill behavior
  - Documents stable identity dedup
- Updated "Change policy" section with new invariants
  - Added per-instance proxy lifecycle preservation
  - Added concurrency guarantees maintenance
  - Added graceful fallback preservation

**docs/mimese-http-header-system-prompt.md changes:**

- Added proxy lifecycle note in section 9 (Compatibility and fallback behavior)
  - Documents per-instance Bun-based proxy architecture
  - Confirms fingerprint mimicry unchanged (still uses Bun TLS)

### Verification

- `npx prettier --check README.md AGENTS.md docs/mimese-http-header-system-prompt.md` passes
- All modified files use correct Prettier code style
- Pre-existing format issue in `.sisyphus/notepads/quality-refactor/decisions.md` is unrelated to this task

### Files Modified

- README.md (added 2 new sections)
- AGENTS.md (added 1 new section, updated 1 section)
- docs/mimese-http-header-system-prompt.md (added proxy lifecycle note)
