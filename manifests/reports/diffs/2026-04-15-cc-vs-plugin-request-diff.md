# Claude Code vs plugin request diff (2026-04-15)

Source captures:

- Claude Code success: flow `658`
- Plugin failure: flow `803`

## Header diff

### Present on Claude Code, missing on plugin

- `anthropic-beta` members:
    - `context-1m-2025-08-07`
    - `redact-thinking-2026-02-12`
    - `advisor-tool-2026-03-01`
    - `advanced-tool-use-2025-11-20`

### Present on plugin, not on Claude Code

- `anthropic-beta` members:
    - `files-api-2025-04-14`
    - `fine-grained-tool-streaming-2025-05-14`
    - `structured-outputs-2025-11-13`
- `x-stainless-helper: )}}function pZ7(q){if(gO8(q))return{`
- `x-session-affinity: ses_...`

### Same header, different value

- `Accept`
    - Claude Code: `application/json`
    - Plugin: `*/*`

## Body diff

### Claude Code

- smaller request body (`Content-Length: 144779`)
- successful Opus request included the first-party beta profile above

### Plugin

- larger request body (`Content-Length: 215900`)
- carried a much larger relocated `<system-instructions>` block
- failed with:

```json
{
    "type": "error",
    "error": {
        "type": "invalid_request_error",
        "message": "You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
    }
}
```

## Practical interpretation

The strongest plugin-owned diffs were:

1. wrong `/v1/messages` beta composition
2. bogus `x-stainless-helper` leakage from candidate-manifest/runtime merge behavior
3. oversized prompt surface relative to the successful Claude Code request

The likely non-plugin-owned diffs were:

1. `Accept: */*`
2. `x-session-affinity`

See also:

- `manifests/reports/diffs/2026-04-15-proxyman-cc-vs-plugin.md`
