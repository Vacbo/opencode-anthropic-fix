# Proxyman diff — Claude Code vs plugin (2026-04-15)

This report compares a successful Claude Code request against a failed plugin request captured in Proxyman on the same machine.

## Evidence used

- **Claude Code success:** flow `658` (`POST /v1/messages?beta=true` → `200`)
- **Plugin failure:** flow `803` (`POST /v1/messages?beta=true` → `400`)
- **Corroborating pair:** Claude Code `75` (`200`) and plugin `725` (`400`)

The plugin failure response body was:

```json
{
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": "You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
    }
}
```

## Highest-confidence wire gaps

### 1. Main `/v1/messages` beta profile does not match Claude Code

Observed on the wire:

| Side                | `anthropic-beta`                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code (`658`) | `claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24` |
| Plugin (`803`)      | `oauth-2025-04-20,claude-code-20250219,files-api-2025-04-14,effort-2025-11-24,context-management-2025-06-27,prompt-caching-scope-2026-01-05,fine-grained-tool-streaming-2025-05-14,structured-outputs-2025-11-13,interleaved-thinking-2025-05-14`             |

Concrete drift:

- **Missing vs CC:** `context-1m-2025-08-07`, `redact-thinking-2026-02-12`, `advisor-tool-2026-03-01`, `advanced-tool-use-2025-11-20`
- **Extra vs CC:** `files-api-2025-04-14`, `fine-grained-tool-streaming-2025-05-14`, `structured-outputs-2025-11-13`

Primary code paths:

- `src/betas.ts`
- `src/headers/builder.ts` (`incomingBeta` is preserved and merged)

Notes:

- `src/betas.ts` intentionally suppresses some upstream betas today (`redact-thinking`, `advanced-tool-use`) or gates them differently.
- The plugin is also preserving incoming betas from upstream request headers, which is likely how `fine-grained-tool-streaming-2025-05-14` and `structured-outputs-2025-11-13` are surviving onto the wire even though they are not added directly in `src/betas.ts`.

### 2. Plugin sends a bogus `x-stainless-helper` header that Claude Code did not send

Observed on the failed plugin request (`803`):

```text
x-stainless-helper: )}}function pZ7(q){if(gO8(q))return{
```

Observed on the successful Claude Code request (`658`):

- no `x-stainless-helper` header present

Primary code paths:

- `src/headers/builder.ts` line setting `x-stainless-helper`
- `src/headers/stainless.ts`
- `src/fingerprint/schema.ts`
- `manifests/candidate/claude-code/2.1.109.json`

Why this looks like a real bug, not just drift:

- The candidate manifest currently contains the same garbage value:

```json
"headers": {
  "xStainlessHeaders": {
    "value": {
      "x-stainless-helper": ")}}function pZ7(q){if(gO8(q))return{"
    }
  }
}
```

- `src/fingerprint/schema.ts` currently allows **sensitive** candidate fields through when `allowCandidateLowRisk` is true:
    - `mergeFieldMetadata(...)` lines `433-439`
- `headers.xStainlessHeaders` is classified as **sensitive**, so this candidate-only garbage should not be making it into runtime.

This is the clearest repo-local parity bug found in this capture pass.

### 3. Plugin request carries `x-session-affinity`; Claude Code capture did not

Observed on plugin (`803`):

```text
x-session-affinity: ses_26d091088ffe227fF3eCSlbOaB
```

Observed on Claude Code (`658`):

- header absent

Repo mapping:

- No match under `src/**`

Interpretation:

- This header is present on the plugin path, but it does **not** appear to be emitted by this repository.
- It likely comes from the OpenCode runtime or another upstream layer.
- It still matters for parity, but the fix may live outside this plugin.

### 4. `Accept` differs on the failing plugin request

Observed on plugin (`803`):

```text
Accept: */*
```

Observed on Claude Code (`658`):

```text
Accept: application/json
```

Repo mapping:

- No match under `src/**`

Interpretation:

- Same as `x-session-affinity`: this is a real wire difference, but not one currently traceable to plugin-owned code.

### 5. Plugin request body is materially larger than Claude Code’s captured request

Observed:

- Claude Code (`658`) `Content-Length: 144779`
- Plugin (`803`) `Content-Length: 215900`

The plugin body preview shows a very large relocated `<system-instructions>` block carrying Sisyphus/OhMyOpenCode orchestration instructions. Claude Code’s successful request is also large, but its captured content is different and shorter.

Primary code paths:

- `src/request/body.ts`
- `src/system-prompt/builder.ts`

This report does **not** claim body size alone caused the failure. It does show the plugin is still shipping a meaningfully larger prompt surface than the successful Claude Code capture.

## Repo-local root causes worth fixing first

### Priority 1 — block sensitive candidate header leakage

Why first:

- It is a concrete bug.
- It is visible on the wire right now.
- It maps cleanly to repo code.

Fix targets:

- `src/fingerprint/schema.ts`
    - stop merging **sensitive** candidate fields when only low-risk candidate usage was intended
- `src/request/profile-resolver.ts`
    - verify normalized profile cannot reintroduce bad manifest header state

Expected outcome:

- `x-stainless-helper` garbage disappears unless explicitly derived from real tool/message fields

### Priority 2 — align default `/v1/messages` beta composition with successful Claude Code capture

Fix targets:

- `src/betas.ts`
- `src/headers/builder.ts`

Specific changes suggested by this capture:

- remove `files-api-2025-04-14` from normal message traffic unless the request actually needs Files API semantics
- stop passing through incoming betas that are not part of the Claude Code baseline for this path
- add the missing CC betas for the Opus path only after confirming they belong on the exact request class we are emulating

### Priority 3 — reduce non-CC prompt payload carried through `<system-instructions>`

Fix targets:

- `src/request/body.ts`
- possibly upstream OpenCode/agent prompt sources, not just this plugin

Reason:

- The plugin request that failed is substantially larger and clearly carries more non-CC orchestration text than the successful Claude Code capture.

## Things this capture does **not** prove yet

- It does **not** prove a single missing header or beta is the sole cause of the `extra usage` rejection.
- It does **not** prove `Accept` or `x-session-affinity` are plugin-owned.
- It does **not** prove the plugin’s `system` array shape is wrong; only that the full request surface still differs.

## Recommended next patch order

1. Fix `src/fingerprint/schema.ts` sensitive-field merge bug.
2. Re-run the same Proxyman comparison.
3. Tighten `/v1/messages` beta filtering in `src/betas.ts` and `src/headers/builder.ts`.
4. Re-capture again before touching prompt relocation.
