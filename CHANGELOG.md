# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-04-11

### Removed

- Dead dependency `@openauthjs/openauth` (unused since the OAuth implementation was replaced by `src/oauth.ts` and `src/token-refresh.ts`). The package had zero references anywhere in source, tests, docs, or config — it was only listed in `package.json`. esbuild was already tree-shaking it out, so the published plugin bundle is byte-for-byte identical to 0.1.2 (SHA `f6a56195...`).

### Security

- Removing `@openauthjs/openauth` eliminates its transitive dependency on `hono`, which reduced `bun audit` findings from 27 → 7 (removed 14 hono-related CVEs plus 6 other transitive vulns). The remaining 7 are all in the dev toolchain (`vitest` → `vite` → `picomatch` / `yaml` / `brace-expansion` chain) and will resolve upstream when those packages release versions with updated inner deps.
- `npm audit fix` applied earlier in 0.1.2's dev-loop also resolved 8 dev-dep CVEs (ajv, brace-expansion, flatted, hono, picomatch, rollup, vite, yaml).

### Notes

- No runtime behavior changes. All 903 tests pass. Plugin SHA unchanged.

[0.1.3]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.3

## [0.1.2] - 2026-04-11

### Fixed

- Removed `./` prefix from `main` and `bin` paths in `package.json` to silence npm publish warnings about "bin[X] script name ... was invalid and removed". The entries were never actually removed — npm's normalizer was auto-stripping the `./` prefix and warning about the diff between `package.json` and the registry manifest. This cosmetic fix aligns both.

### Notes

- No runtime behavior changes. `npm install @vacbo/opencode-anthropic-fix` continues to create working symlinks for `opencode-anthropic-auth` and `oaa` in `node_modules/.bin` (verified in 0.1.1 and unchanged in 0.1.2).

[0.1.2]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.2

## [0.1.1] - 2026-04-11

### Fixed

- Dead conditional in `bun-fetch.ts` `reportFallback` function where both if/else branches executed identical `console.error` calls
- 16 lint errors: 12 CommonJS `require()` calls in `scripts/mock-upstream.js` and `scripts/rotation-test.js` converted to ESM `import`
- 4 empty catch blocks in `src/bun-fetch.ts` and `src/response/streaming.ts` annotated with explanatory comments

### Notes

- This is the first published release of the 0.1.x line. Version 0.1.0 was the plan completion checkpoint but was not published to npm; 0.1.1 is what ships with post-review fixes applied.

[0.1.1]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.1

## [0.1.0] - 2026-04-10

### Fixed

- Parallel subagent failures that caused "tool_use" orphan errors when multiple concurrent requests were in flight
- SSE streaming fragility that produced "Unable to connect" errors under concurrent load
- Duplicate account creation when token rotation occurred during parallel OAuth flows
- 55+ inventoried bugs related to race conditions in account management and request handling

### Changed

- Proxy lifecycle: each OpenCode instance now owns its own dedicated proxy process instead of sharing a global proxy
- Refresh lock constants widened to 15-second timeout and 90-second stale threshold for better reliability under load
- SSE event-framing completely rewritten for robustness with concurrent streams
- Account deduplication strategy now uses identity-based matching instead of email-only comparison

### Added

- Account identity abstraction module for stable identity resolution across OAuth flows
- Circuit breaker implementation for per-request failure isolation (prevents one bad request from affecting others)
- Parent PID watcher for cross-platform proxy death detection
- 10 new test files covering parallel request scenarios and account deduplication edge cases
- `scripts/qa-parallel.sh` and `scripts/rotation-test.js` for manual QA verification

### Removed

- Global health check failure counter (replaced with per-request circuit breaker)
- Fixed port 48372 assignment (now uses ephemeral port allocation)
- Global PID file (now uses per-instance process tracking)
- Global process event handlers (replaced with parent-PID monitoring)

[0.1.0]: https://github.com/marco-jardim/opencode-anthropic-fix/releases/tag/v0.1.0
