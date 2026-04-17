# Fingerprint Ingestion Pipeline

## Overview

The fingerprint-ingestion pipeline automatically discovers upstream Claude Code request-shape changes and manages them through a staged verification process. It separates **candidate** fingerprints (statically extracted from npm bundles) from **verified** fingerprints (confirmed through live proxy capture), ensuring that only validated request-shaping data influences runtime behavior.

## Architecture

### GitHub Actions — Candidate Discovery

Runs on schedule and on demand without requiring secrets.

**Responsibilities:**

- Detect new `@anthropic-ai/claude-code` npm versions
- Download and extract the npm bundle
- Parse bundle fingerprints into a structured candidate manifest
- Diff against previous candidate and verified manifests
- Publish sanitized artifacts
- Open or update a PR with generated candidate files and a human-readable summary

**Constraints:**

- Public npm assets only
- No OAuth, browser, or session secrets
- No live request capture
- No runtime promotion of auth-critical fields

### Trusted Verifier Runner — This Machine

Runs manually or from a local scheduled job on this machine.

**Responsibilities:**

- Fetch a candidate manifest version
- Run live proxy-capture verification against OG Claude Code and the plugin
- Execute a fixed verification scenario set
- Classify mismatches by severity
- Promote only confirmed fields into a verified manifest overlay
- Optionally open a PR with the verified overlay and diff evidence

**Later Migration:**

- Move this exact runner to an always-on trusted host
- Keep the same CLI and manifest contract so the execution environment changes without redesigning the pipeline

### Runtime Consumer — Plugin

**Responsibilities:**

- Load manifests from the filesystem
- Select a request profile dynamically based on runtime context
- Compose headers, body, betas, and prompt strategy from manifest-driven rules
- Prefer `verified` data over `candidate` data
- Fall back safely to repository defaults when no manifest entry exists

## Manifest Model

### Directory Layout

```text
manifests/
  candidate/
    claude-code/
      2.1.109.json
      index.json
  verified/
    claude-code/
      2.1.109.json
      index.json
  reports/
    diffs/
    verification/
```

### Candidate Manifest

Represents static evidence inferred from the npm bundle.

**Required fields:**

- `version`: Claude Code version string
- `source`: NPM package metadata, tarball URL/hash, extraction timestamp
- `fields`: All request-shaping fields with metadata
- `confidence`: Per-field confidence level
- `risk`: Per-field risk classification
- `origin`: Per-field origin (`bundle-string`, `bundle-heuristic`, `known-stable`)
- `parserWarnings`: Any warnings during extraction
- `unknownFields`: Fields detected but not understood

### Verified Manifest

Represents fields confirmed by live capture.

**Required fields:**

- `version`: Claude Code version string
- `verifiedAt`: ISO timestamp of verification
- `verifiedBy`: Machine or runner label (not personal secrets)
- `scenarioIds`: Which verification scenarios were used
- `promotedFields`: Fields that passed verification
- `rejectedCandidateFields`: Fields that failed verification with reasons
- `evidenceArtifacts`: Paths to raw evidence (not committed)

### Merge Semantics

Runtime precedence:

1. `verified` field (highest priority)
2. `candidate` field when marked low-risk and explicitly allowed
3. Repository fallback default (lowest priority)

Auth-sensitive fields must **never** use candidate-only data without explicit allowlisting.

## Schema Coverage

The manifest schema covers these request-shaping domains:

### 1. Transport

- Path and query style (`/v1/messages?beta=true`)
- Required default headers
- Authentication header mode

### 2. Header Profile

- `user-agent` string
- `x-app` header
- `x-stainless-*` headers
- `x-client-request-id`
- `x-claude-code-session-id`

### 3. Beta Composition

- Required base betas
- Optional or tool/SDK betas
- Auth-mode-specific betas

### 4. Billing/Attribution

- `cc_version` value
- `cc_entrypoint` value
- `cch` strategy

### 5. Body Schema

- Default `stream` setting
- Default `max_tokens` value
- `temperature` presence or absence
- `thinking`, `context_management`, `tools` keys

### 6. Prompt Strategy

- Identity string variant
- Billing block placement
- Append versus relocation mode
- Cache-control behavior

### 7. Metadata/Session Semantics

- `metadata.user_id` shape
- Device, account, and session linkage

## Risk Classification

### Critical Fields

Fields affecting authentication, identity, billing, metadata, or transport shape:

- `transport.authHeaderMode`
- `betas.requiredBaseBetas`
- `betas.authModeBetas`
- `headers.userAgent`
- `headers.xApp`
- `billing.ccEntrypoint`
- `metadata.userIdShape`
- `prompt.identityString`
- `prompt.billingBlockPlacement`
- `prompt.cacheControlBehavior`
- `body.defaultStream`
- `body.defaultMaxTokens`

### Sensitive Fields

Fields affecting request fingerprinting:

- `headers.xStainlessHeaders`
- `headers.xClientRequestId`
- `headers.xClaudeCodeSessionId`
- `betas.optionalBetas`
- `transport.defaultHeaders`
- `transport.pathStyle`

### Low-Risk Fields

Descriptive metadata and documentation-only hints:

- `billing.ccVersion`
- `metadata.deviceLinkage`
- `metadata.accountLinkage`

## Promotion Rules

### Auto-promotable from Candidate

These can be promoted without live verification:

- Descriptive non-runtime metadata
- Low-risk extracted inventory fields
- Documentation summaries

### Must Be Live-Verified

These require live capture confirmation:

- Authentication header mode
- `anthropic-beta` composition
- `user-agent` mode
- `x-app`, `cc_entrypoint`, `metadata.user_id`
- System block structure
- `cache_control`
- `cch` behavior
- Request body defaults

## Verification Scenarios

### minimal-hi

Basic greeting request to verify core request shape.

**Prompt:** `hi`

**Expected behavior:** Simple text response with standard headers and body format.

**Verifies fields:**

- `transport.pathStyle`
- `headers.userAgent`
- `headers.xApp`
- `betas.requiredBaseBetas`
- `body.defaultStream`

### tool-search

Request with tool use to verify tool-related headers and body fields.

**Prompt:** `Search for files matching *.ts in the current directory`

**Expected behavior:** Tool use request with proper tool definitions in body.

**Verifies fields:**

- `body.toolsKey`
- `betas.optionalBetas`
- `headers.xStainlessHeaders`

### append-system-prompt

Request with system prompt to verify prompt handling.

**Prompt:** `Explain how system prompts work`

**Expected behavior:** Response acknowledging system prompt context.

**Verifies fields:**

- `prompt.identityString`
- `prompt.billingBlockPlacement`
- `prompt.appendMode`
- `metadata.userIdShape`

### oauth-token-refresh

OAuth flow to verify auth-specific headers and betas.

**Prompt:** (empty, triggers token refresh)

**Expected behavior:** Token refresh with proper OAuth headers and betas.

**Verifies fields:**

- `transport.authHeaderMode`
- `betas.authModeBetas`
- `billing.ccEntrypoint`
- `billing.cchStrategy`

## Usage Guide

### For CI/CD (GitHub Actions)

The `fingerprint-candidate.yml` workflow runs automatically:

1. On a daily schedule
2. On manual trigger via `workflow_dispatch`
3. When notified of a new Claude Code release

The workflow:

1. Detects the latest npm version
2. Downloads and extracts the bundle
3. Builds a candidate manifest
4. Diffs against existing manifests
5. Uploads artifacts
6. Opens or updates a PR

### For Local Verification

Preferred local verification flow on this machine:

```bash
# 1. Capture OG Claude Code and plugin/OpenCode separately with the passive HTTPS proxy
bun scripts/validation/proxy-capture.ts
# Run the capture helper under Bun so the validation path keeps Claude Code's runtime/TLS shape.

# 2. Compare the saved captures offline
bun scripts/verification/run-live-verification.ts \
  --version 2.1.109 \
  --scenario minimal-hi \
  --og-capture /path/to/og-capture.json \
  --plugin-capture /path/to/plugin-capture.json \
  --report manifests/reports/verification/2.1.109-minimal-hi.json

# 3. Promote verified fields to the verified manifest
bun scripts/verification/promote-verified.ts \
  --version 2.1.109 \
  --report manifests/reports/verification/2.1.109-minimal-hi.json
```

`run-live-verification.ts` still supports inline command execution for debugging, but passive capture plus offline comparison is the trusted path.

### For Runtime Consumption

The plugin automatically:

1. Loads candidate and verified manifests on startup
2. Merges them according to precedence rules
3. Uses the resulting request profile for all API calls
4. Falls back to hardcoded defaults if no manifests exist

## Migration Notes

### Moving to an Always-On Host

The trusted verifier can be moved to a dedicated host with minimal changes:

1. Copy the verification scripts to the new host
2. Install the same dependencies (Bun, Node.js)
3. Configure environment variables for the host
4. Set up a scheduler (cron, systemd timer, or LaunchAgent)
5. Update the `verifiedBy` label to reflect the new host

The CLI contract and manifest format remain unchanged, so the migration is purely operational.

### Configuration Changes Only

When moving to the always-on host, only these configuration items need updating:

- `verifiedBy` label in verification config
- Artifact storage paths
- Scheduler configuration
- Notification endpoints (if any)

No code changes are required.
