# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
