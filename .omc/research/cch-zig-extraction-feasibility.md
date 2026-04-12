# CCH Zig Extraction — Feasibility Analysis

**Date:** 2026-04-11
**Question:** Can we strip the Zig hash function out of the Claude Code binary and call it via FFI from our Bun proxy, achieving "perfect" cch attestation?
**Verdict:** No to extraction. Yes to a clean reimplementation. The "secret sauce" is xxHash64 with one published seed constant.

---

## TL;DR

1. **Premise verified:** A Zig hash function does exist inside CC's standalone binary, and it does compute the per-request `cch` attestation that the JS layer leaves as `cch=00000`.
2. **Premise refined:** The function is `xxHash64` with seed `0x6E52736AC806831E` — a public, well-known, non-cryptographic hash. Not proprietary, not novel, not Anthropic-specific.
3. **Approach rejected:** `bun:ffi` cannot `dlopen` a function carved out of an executable. Bun's FFI requires a proper shared library (`.dylib`/`.so`/`.dll`) with a dynamic symbol table. CC's binary is `MH_EXECUTE` with no exported symbols.
4. **Recommended path:** Reimplement xxHash64 in TypeScript (~30 lines, works in both Node and Bun). Optional follow-up: package the same logic as our own Zig dylib if we want a Zig→Zig story.
5. **Open empirical question:** Whether the cch actually drives any server behavior in 2026. Prior research said no for routing; new third-party reverse-engineering suggests it may gate fast-mode access. **Validation needed before any implementation.**

---

## 1. Two Distribution Channels for Claude Code

This is the load-bearing distinction the original "extract from CC" framing missed.

| Channel                                  | Files shipped                                                                | Runtime                                              | cch behavior                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `npm install -g @anthropic-ai/claude-code` | `cli.js` (13.6 MB), prebuilt audio-capture `.node` addons, ripgrep, seccomp     | **Node.js**                                              | Placeholder only — no native attestation runs                 |
| `claude.ai/install.sh` → GCS               | Single 200–245 MB executable (one per platform)                              | **Custom private Bun fork** (`1.3.9-canary.51+d5628db23`) | Native Zig attestation runs and replaces `cch=00000` in-place |

The standalone binary is built with `bun build --compile` from a private Bun fork that only Anthropic ships. The Zig attestation code lives in `bun-anthropic/src/http/Attestation.zig` per the leaked source at `alex000kim/claude-code/src/constants/system.ts`.

The npm package contains **zero** native hash code. Its `.node` addons are for audio capture only. Its bundled binaries (ripgrep, seccomp) are unrelated tools.

**Implication:** When the user runs CC via `npx @anthropic-ai/claude-code` (not the standalone binary), there is no native attestation. The placeholder is either omitted via the `NATIVE_CLIENT_ATTESTATION` feature flag or sent to the server as `cch=00000`. The fact that npm-CC works at all means the server either accepts non-attested requests or has a separate validation path.

---

## 2. The Hash Function — Confirmed Algorithm and Constants

**Algorithm:** `xxHash64` (Yann Collet, public domain)
**Seed:** `0x6E52736AC806831E` (64-bit, baked into the Bun binary's data section)
**Input:** Serialized JSON request body bytes
**Output:** `format(xxh64(body, seed) & 0xFFFFF, "05x")` — 20-bit truncation as 5-char zero-padded hex

**Reference Python implementation:**

```python
import xxhash
SEED = 0x6E52736AC806831E
def cch(body: bytes) -> str:
    return format(xxhash.xxh64(body, seed=SEED).intdigest() & 0xFFFFF, "05x")
```

**Mechanism in the standalone binary:**

1. The JS layer (function `mk_()`, offset 73,642,095 in CC 2.1.98) builds the billing string with `cch=00000` as a literal placeholder
2. The billing string is injected as the first text block of the `system` array, with `cacheScope: null`
3. The system array is serialized to JSON as part of the request body
4. Bun's native `fetch()` (Zig) detects the `cch=00000` ASCII bytes in the serialized body
5. It computes `cch = xxh64(body, SEED) & 0xFFFFF`, formats as 5-char hex, and **mutates the bytes in-place** before TLS encryption (which is technically a JS spec violation — mutating immutable string contents — but it's all happening below the V8/JSC level so JS never sees the mutation)

The **version suffix** (the 3-char hex after `cc_version=2.1.98.`) is computed at JS-level using SHA-256 with salt `59cf53e54c78` and characters from positions [4,7,20] of the first user message. The plugin already implements this correctly in `src/headers/billing.ts:31-33`.

### Public reverse-engineering sources

| Source                                                                                                        | Method                                       | Key finding                                                          |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| [a10k.co](https://a10k.co/b/reverse-engineering-claude-code-cch.html)                                          | LLDB hardware watchpoints + 142 oracle pairs | xxHash64 seed `0x6E52736AC806831E`, ~30-line PoC                       |
| [Reddit r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1s7mkn3/)                                       | Ghidra + radare2                             | "Native-layer string replacement in Anthropic's custom Bun fork"     |
| [alex000kim/claude-code](https://github.com/alex000kim/claude-code/blob/main/src/constants/system.ts) (leaked) | Source                                       | `feature('NATIVE_CLIENT_ATTESTATION') ? ' cch=00000;' : ''` reference |
| `.omc/research/cch-source-analysis.md` (this repo, prior session)                                              | Static analysis of CC 2.1.98 binary          | `mk_()` function reverse-engineered, `J$8()` version-suffix algorithm  |
| `.omc/research/cch-binary-analysis.md` (this repo, prior session)                                              | Mach-O section analysis                      | Confirms `cch=00000` is a static literal in the JS bundle            |

The version-suffix algorithm was independently confirmed by the prior session's binary analysis.

---

## 3. Why "Extract and FFI" Doesn't Work

`bun:ffi` is a thin wrapper around Zig's `std.DynLib.open()`, which itself wraps:

- POSIX: `dlopen()` + `dlsym()`
- Windows: `LoadLibraryA()` + `GetProcAddress()`

Source: [`oven-sh/bun src/bun.js/api/ffi.zig#L1068-L1093`](https://github.com/oven-sh/bun/blob/HEAD/src/bun.js/api/ffi.zig#L1068-L1093)

### Hard requirements for any binary loaded by `dlopen`

1. Must be a **proper shared library** (Mach-O `MH_DYLIB`, ELF `.so`, PE `.dll`) — not an executable, not a `.a` static archive, not an object file
2. Must have **exported symbols in the dynamic symbol table** (`__attribute__((visibility("default")))` on POSIX, `__declspec(dllexport)` on Windows)
3. Must use the **C calling convention** (cdecl on x86_64, AAPCS on arm64). No `stdcall`, no `thiscall`, no custom ABIs.
4. Must be **position-independent** (`-fPIC`)

### CC's binary fails every requirement

| Requirement              | CC binary status                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mach-O type              | `MH_EXECUTE` — `dlopen` will refuse to load it                                                                                                                                                              |
| Exported symbols for cch | None. The cch hash function is welded into Bun's HTTP send path. No symbol named anything like `attest`, `cch`, `compute_attestation`, `xxh64_billing` exists in the binary's dynamic symbol table. |
| Calling convention       | Unknown — function is internal, no public ABI                                                                                                                                                             |
| Function isolation       | Function references hundreds of internal Bun runtime symbols (allocator, request buffer, runtime state). It is not callable in isolation even if you found its address.                                 |

The hex-formatter at IDA offset `0x101D9380C`, identified in the prior binary analysis, is **NOT** the cch function — it is a generic 25-caller helper used for debug message formatting, struct layout errors, and UTF-8 byte display. None of its callers are billing-related.

### The `linkSymbols`/`CFunction` escape hatch (and why it's not worth it)

`bun:ffi` does support calling a function by raw pointer via `linkSymbols`. In theory you could:

1. Parse the Mach-O headers manually to find function offsets
2. `mmap` the binary with `PROT_EXEC`
3. Compute the runtime address after ASLR
4. Manually fix up relocations to all internal symbols the function depends on
5. Pass that address to `linkSymbols` and call it

**Why this is impractical:**

- Requires reverse engineering the function's address and size for every CC release
- Requires understanding and re-resolving every internal Bun symbol the function references
- Breaks every time CC updates the Bun runtime
- Fragile to ASLR, code signing, hardened runtime
- Months of engineering for a function that can be reimplemented in 30 lines

This approach is not recommended.

---

## 4. Viable Options Compared

| Option                                               | Effort   | Functional outcome | Maintenance         | Notes                                                                       |
| ---------------------------------------------------- | -------- | ------------------ | ------------------- | --------------------------------------------------------------------------- |
| **A. xxHash64 in TypeScript**                        | ✅ done   | Identical bytes    | Zero                | Implemented in `src/headers/cch.ts` and wired post-serialization in `transformRequestBody()`. |
| **B. Our own Zig dylib + bun:ffi**                   | ~2-3 days | Identical bytes    | Per-platform builds | Zig→Zig aesthetic. Forces hashing into Bun-only proxy path; breaks fallback. |
| **C. Carve from CC binary, `linkSymbols` raw pointer** | Weeks    | Identical bytes    | Constant breakage   | Fragile, complex, no benefit over A or B.                                   |
| **D. Status quo** (current `sha256[:5]` placeholder)  | None     | Different bytes    | Zero                | Defensible per prior research; risky if cch gates anything in 2026.         |

### Option A details

```typescript
// implemented in src/headers/cch.ts
export const CCH_SEED = 0x6e52_736a_c806_831en;
export const CCH_PLACEHOLDER = "00000";

export function computeNativeStyleCch(serializedBody: string): string {
  const hash = xxHash64(new TextEncoder().encode(serializedBody), CCH_SEED);
  return (hash & 0x0f_ffffn).toString(16).padStart(5, "0");
}
```

That is now the implemented design: `buildAnthropicBillingHeader()` emits `cch=00000`, `transformRequestBody()` serializes the full request, then `replaceNativeStyleCch()` computes the xxHash64 value over the serialized body and swaps the placeholder in-place.

- Compute cch first, then write it directly into the body before serialization (need to know serialized form)
- Or: serialize with placeholder, compute cch over the serialized bytes, then replace `cch=00000` with the computed value (this is what CC's Zig layer does)

The latter is closer to CC's actual behavior and matches the "in-place mutation" semantics. It requires us to do the body serialization in a place where we can also rewrite the bytes — which means doing it in the proxy layer (`src/bun-proxy.ts`) after `JSON.stringify`, not in the body transformer (`src/request/body.ts`) where the body is still an object.

This is a non-trivial refactor: cch computation must move from `src/headers/billing.ts` (object level, before serialization) into the proxy (after serialization). The current placeholder approach computes a fake hash from the message array and embeds it during object construction; the real approach computes a hash over the final wire bytes.

### Option B details

`build.zig`:
```zig
const std = @import("std");
pub fn build(b: *std.Build) void {
    const lib = b.addSharedLibrary(.{
        .name = "cc_hash",
        .root_source_file = .{ .path = "src/cc_hash.zig" },
        .target = b.standardTargetOptions(.{}),
        .optimize = .ReleaseFast,
    });
    b.installArtifact(lib);
}
```

`src/cc_hash.zig`:
```zig
const std = @import("std");
const xxh = std.hash.XxHash64;

const CCH_SEED: u64 = 0x6E52736AC806831E;

pub export fn cc_hash_xxh64(data: [*]const u8, len: usize, out: *[5]u8) void {
    const slice = data[0..len];
    const h = xxh.hash(CCH_SEED, slice);
    const truncated = h & 0xFFFFF;
    _ = std.fmt.bufPrint(out, "{x:0>5}", .{truncated}) catch unreachable;
}
```

Loading from Bun:
```typescript
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const lib = dlopen(`./vendor/libcc_hash.${suffix}`, {
  cc_hash_xxh64: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.void,
  },
});

const out = new Uint8Array(5);
lib.symbols.cc_hash_xxh64(ptr(buf), buf.byteLength, ptr(out));
const cch = new TextDecoder().decode(out);
```

**Real-world precedent:** [OpenTUI](https://github.com/anomalyco/opentui) uses Zig + bun:ffi in production with 100+ symbols.

**Trade-off:** Option B forces hash computation into the Bun-only proxy path. The native-fetch fallback (`src/bun-fetch.ts`) would need to either reimplement the hash in JS anyway, or skip cch entirely. Option A avoids that fork.

---

## 5. Open Empirical Question: Does cch Actually Matter?

The prior session's `.omc/research/cc-vs-plugin-comparison.md` §8 verdict:
> **cch attestation hash** | Ruled out — server accepts non-attested values; **TLS is the signal**

But the a10k.co reverse-engineering report claims:
> "Get it wrong, and the API rejects your request with 'Fast mode is currently available in research preview in Claude Code. It is not yet available via API.'"

These are not necessarily contradictory:

- Prior session may have tested whether cch affects **routing** (included quota vs extra usage) and concluded no
- a10k.co may have tested whether cch affects **fast-mode access** specifically

It is plausible that:

- Routing to included quota is governed by **TLS fingerprint** (Bun BoringSSL signature)
- Fast-mode gating is governed by **valid cch attestation**
- And the plugin currently sends a fake cch that the server tolerates for routing but does not unlock fast mode

This needs empirical validation before any code changes. **See "Recommended next step" below.**

---

## 6. Validation Outcome + Implementation Status

The validation was completed (see `cch-validation-2026-04-11.md`) and the TypeScript implementation is now in place.

1. **Capture a real CC 2.1.101 request** to `/v1/messages` (using `.omc/research/proxy-capture.mjs` or Proxyman). Note the cch value, the response status, the model being used, and any indication of fast-mode behavior in the response (e.g., latency, headers, or error messages).
2. **Capture an equivalent plugin request** with the same prompt, model, and account. Note the same fields. Confirm the plugin is currently sending the fake `sha256[:5]` cch.
3. **Replay both requests** with the same body but different cch values: real, fake, and `00000`. Compare server responses for any difference in:
   - HTTP status code
   - Response headers (especially `x-anthropic-*`)
   - Stream first-token latency (proxy for fast-mode)
   - Any error message about "Fast mode is currently available in research preview"
   - Whether the request lands on included quota or extra usage (check account usage afterward)
The key conclusion changed:

- the server currently tolerates `00000`, random values, and native-style xxHash64 values,
- but the plugin now matches the standalone binary's body-shaping path for byte-level parity and future-proofing.

---

## 7. Cross-References

**In this directory:**

- `cch-source-analysis.md` — Reverse-engineered `mk_()` and `J$8()` functions from CC 2.1.98
- `cch-binary-analysis.md` — Static analysis of CC binary, confirms `cch=00000` is a literal
- `cch-dynamic-analysis.md` — Frida/lldb tooling for runtime cch capture
- `cch-captures.md` — Real captured cch values from CC 2.1.98 (e.g., `ea956`, `f0c71`, `4dac2`)
- `cc-vs-plugin-comparison.md` — Full plugin-vs-CC fingerprint comparison
- `proxy-capture.mjs` — MITM proxy for capturing cch values
- `compare-requests.mjs` — Comparison proxy for replay testing
- `capture-cch.sh` — Wrapper to launch CC under Proxyman
- `frida-cch.js` — Frida hooks for SHA-256, memcpy(5), hex-formatter
- `lldb-cch.py` — LLDB hardware watchpoints on `cch=00000` placeholder

**In the plugin source:**

- `src/headers/billing.ts:31-34` — Version-suffix SHA-256 implementation (correct, matches CC)
- `src/headers/cch.ts` — Native-style xxHash64 constants + placeholder replacement
- `src/request/body.ts:322` — Final serialized-body cch replacement point
- `src/bun-proxy.ts` — Bun-only proxy where Option B's FFI call would live
- `src/bun-fetch.ts:413-418` — Native fetch fallback (does not run through the Bun proxy)

**External references:**

- a10k.co reverse-engineering report: <https://a10k.co/b/reverse-engineering-claude-code-cch.html>
- Reddit thread: <https://www.reddit.com/r/ClaudeAI/comments/1s7mkn3/>
- alex000kim/claude-code (leaked source): <https://github.com/alex000kim/claude-code>
- bun:ffi source: <https://github.com/oven-sh/bun/blob/HEAD/src/bun.js/api/ffi.zig>
- OpenTUI (real-world Zig+bun:ffi): <https://github.com/anomalyco/opentui>

---

## 8. What This Document Replaces / Updates

This document supersedes the implicit assumption (in the original "extract Zig from CC" framing) that:

- **The hash is proprietary** — No, it is xxHash64.
- **Extraction via FFI is feasible** — No, `bun:ffi` cannot `dlopen` non-shared-library binaries.
- **Perfect mimicry requires native code** — No, a 30-line TS reimplementation produces identical bytes.
- **The npm package contains the Zig hash** — No, only the standalone Bun executable does.

It does NOT supersede the prior `cch-*.md` files in this directory. Those remain accurate for what they cover (binary analysis, source recovery, dynamic analysis tooling, captured values).

The **next session's open question** is empirical: validate whether real cch behaves differently from the current fake cch in production traffic, then decide whether to implement Option A.
