# CCH Validation — 2026-04-11

## Question

Does the `cch` value in `x-anthropic-billing-header` change server behavior for the plugin in 2026?

The prior reverse-engineering work said no: TLS fingerprinting was the real routing signal and `cch` looked decorative. A newer third-party write-up claimed wrong `cch` values could trigger a fast-mode rejection. This run was meant to settle that.

## Scope of this run

- **CC version installed:** `2.1.101`
- **Model under test:** `claude-sonnet-4-5`
- **Prompt:** `Reply with the single word: OK`
- **Transport:** Proxyman MITM for the standalone CC request; `curl` replays for plugin variants
- **Accounts:** The active account in `anthropic-accounts.json`, which is a `cc-keychain` identity reused by the plugin

Important constraint: both local accounts hit `100%` of the 5h window during the run, so this validation stopped after the minimum useful capture set.

## Setup

### 1. Standalone CC

`claude --print "Reply with the single word: OK"` ran successfully under Proxyman after sourcing:

```bash
set -a 2>/dev/null || true
source "/Users/vacbo/Library/Application Support/com.proxyman.NSProxy/app-data/proxyman_env_automatic_setup.sh"
set +a 2>/dev/null || true
```

Result:

```text
OK
```

This confirmed that `claude` 2.1.101 was working through the Proxyman CA path. Programmatic extraction of the exact `/v1/messages` body from Proxyman's internal `SavedRequests` file was not completed during this window, so the standalone CC request is only a sanity check in this run, not the main evidence source.

### 2. Plugin request synthesis

Two helper scripts were added for the validation run:

- `scripts/validation/capture-plugin-bytes.ts`
- `scripts/validation/proxy-capture.mjs`

`capture-plugin-bytes.ts` imports the plugin's real request shapers:

- `transformRequestBody()` from `src/request/body.ts`
- `buildRequestHeaders()` from `src/headers/builder.ts`

It then emits the exact body + headers the plugin would send, without needing to drive a live `opencode` session.

This matters because it keeps the test focused: same body bytes, same headers, same account, same model. Only the five `cch` characters change.

## What was tested

One synthesized body was generated first, then two variants were derived from it by replacing only the `cch` substring.

Base synthesized body:

```text
x-anthropic-billing-header: cc_version=2.1.101.0e7; cc_entrypoint=cli; cch=70e69;
```

Three request bodies were replayed to `https://api.anthropic.com/v1/messages?beta=true`:

| Variant | `cch` value | Construction |
| --- | --- | --- |
| `base` | `70e69` | Plugin's current `sha256(...).slice(0, 5)` logic from `src/headers/billing.ts:55-68` |
| `zeros` | `00000` | Literal placeholder that the standalone Bun binary is supposed to overwrite |
| `random` | `ffffe` | Arbitrary valid 5-char lowercase hex |

The three JSON files were byte-identical except for those five characters:

```text
body-base.json:   cch=70e69  bytes=617
body-zeros.json:  cch=00000  bytes=617
body-random.json: cch=ffffe  bytes=617
```

`diff` confirmed that no other byte changed.

## Results

All three variants succeeded.

### HTTP outcome

| Variant | HTTP | Wall time |
| --- | --- | --- |
| `base` | `200` | `1.061304s` |
| `zeros` | `200` | `0.890947s` |
| `random` | `200` | `0.905272s` |

### Response payload

Every variant returned the same semantic response:

```json
{
  "model": "claude-sonnet-4-5-20250929",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "OK" }],
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 28,
    "output_tokens": 4,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "service_tier": "standard",
    "inference_geo": "not_available"
  },
  "context_management": { "applied_edits": [] }
}
```

The only field that changed between responses was the server-issued message ID.

### Most important field

`usage.service_tier` was **`"standard"` for all three variants**.

If `cch` were gating fast-mode, special routing, included quota, or extra-usage routing in this request path, this is the field most likely to diverge. It did not.

## Verdict

For this request shape, on `claude-sonnet-4-5`, against the current server behavior on 2026-04-11:

> **The server does not validate `cch`.**

It accepted:

- the plugin's current fake `cch`
- the literal placeholder `00000`
- a random valid-looking five-hex value

and returned the same status, same model, same token usage, same `service_tier`, and same answer.

That is strong evidence that `cch` is not part of the server's acceptance logic for this path.

## What this means for the extraction question

This validation materially changes the cost/benefit math from `cch-zig-extraction-feasibility.md`.

That document already concluded:

1. The standalone CC binary contains a real Zig attestation path
2. The algorithm appears to be `xxHash64` with seed `0x6E52736AC806831E`
3. Extracting that native function out of the Bun executable and calling it from our Bun proxy via `bun:ffi` is the wrong approach technically

This validation adds the missing practical conclusion:

> **There is no reason to do it.**

Not because extraction is hard, but because the server does not care.

## Recommendation

### Validation result

The server tolerated all tested variants (`00000`, random-looking 5-hex, and the plugin's previous fake cch) and returned `service_tier: "standard"` in each case.

### Implementation status

The plugin has since been updated to match the standalone binary's body-shaping path more closely:

1. `buildAnthropicBillingHeader()` emits `cch=00000`
2. `transformRequestBody()` serializes the full body
3. `replaceNativeStyleCch()` computes `xxHash64(serializedBody, seed=0x6E52736AC806831E) & 0xFFFFF`
4. the placeholder is replaced in-place before the request leaves the plugin

That change was made for parity and future-proofing, not because the current server behavior requires it.

### If we revisit this later

The only reason to revisit `cch` would be one of these:

1. A future regression where Anthropic starts rejecting `00000` or random values
2. Evidence that another model or endpoint behaves differently
3. Evidence that the standalone CC binary gets a different `service_tier` for the same request under the same account

If Anthropic tightens enforcement later, the plugin now already has the small TS implementation of the known `xxHash64` formula.

## Artifacts

### New files from this run

- `scripts/validation/capture-plugin-bytes.ts`
- `scripts/validation/proxy-capture.mjs`
- `/tmp/cch-validation/body-base.json`
- `/tmp/cch-validation/body-zeros.json`
- `/tmp/cch-validation/body-random.json`
- `/tmp/cch-validation/response-base.txt`
- `/tmp/cch-validation/response-zeros.txt`
- `/tmp/cch-validation/response-random.txt`

### Preserved historical artifacts

- `.omc/research/cch-captures.md`
- `.omc/research/cch-captures.2026-04-09-cc2.1.98.md.bak`

## Bottom line

The reverse-engineering was interesting. The extraction idea was clever. But the validation result is blunt:

**`cch` is not buying us anything right now.**

The perfect Meme Crate, at least here, is still the Bun/TLS path — not the Zig hash.
