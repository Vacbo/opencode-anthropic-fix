// ===========================================================================
// System Prompt Structure — CC Alignment Audit
// ===========================================================================
//
// Audit date: 2026-04-10
// Reference: .omc/research/cch-source-analysis.md,
//   .omc/research/cc-vs-plugin-comparison.md
//
// VERIFIED ALIGNMENT:
// [x] Billing block placement: inserted first in the system array, with no
//     cache_control on the emitted block.
// [x] Identity string text matches CC exactly:
//     "You are Claude Code, Anthropic's official CLI for Claude."
// [x] Identity cache_control matches CC's request shape:
//     { type: "ephemeral" }.
// [x] Block ordering remains billing → identity → remaining sanitized blocks.
// [x] Sanitization rewrites OpenCode-specific references toward Claude/Claude
//     Code phrasing before final prompt assembly.
//
// FUTURE HARDENING NOTES:
// - CC's full system prompt is much larger (tool instructions, permissions,
//   internal workflow text). This builder intentionally preserves only the
//   routing-critical structure documented in the source analysis.
// - CC records billing cache behavior internally as cacheScope: null. The
//   plugin emits no cache_control field on the billing block, which is the
//   equivalent wire representation.
// - CC can append cc_workload when AsyncLocalStorage workload tracking is
//   present. That field is not applicable to this plugin.
// - CC tool naming conventions can evolve independently from this file. Current
//   plugin-specific tool prefix notes live in body/request docs, not here.
//
// See src/headers/billing.ts for version-suffix derivation and src/headers/cch.ts
// for placeholder replacement and native-style cch computation.
// ===========================================================================

import {
    CLAUDE_CODE_IDENTITY_STRING,
    COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT,
    KNOWN_IDENTITY_STRINGS,
} from "../constants.js";
import { buildAnthropicBillingHeader } from "../headers/billing.js";
import type { SignatureConfig, SystemBlock } from "../types.js";
import { dedupeSystemBlocks, isTitleGeneratorSystemBlocks } from "./normalize.js";
import { compactSystemText, sanitizeSystemText } from "./sanitize.js";

export function buildSystemPromptBlocks(
    system: SystemBlock[],
    signature: SignatureConfig,
    messages: unknown[],
): SystemBlock[] {
    const titleGeneratorRequest = isTitleGeneratorSystemBlocks(system);

    let sanitized: SystemBlock[] = system.map((item) => ({
        ...item,
        text: compactSystemText(
            sanitizeSystemText(item.text, signature.sanitizeSystemPrompt === true),
            signature.promptCompactionMode,
        ),
    }));

    if (titleGeneratorRequest) {
        sanitized = [{ type: "text", text: COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT }];
    } else if (signature.promptCompactionMode !== "off") {
        sanitized = dedupeSystemBlocks(sanitized);
    }

    if (!signature.enabled) {
        return sanitized;
    }

    const filtered = sanitized.filter(
        (item) => !item.text.startsWith("x-anthropic-billing-header:") && !KNOWN_IDENTITY_STRINGS.has(item.text),
    );

    const blocks: SystemBlock[] = [];
    const billingHeader = buildAnthropicBillingHeader(signature.claudeCliVersion, messages);
    if (billingHeader) {
        blocks.push({ type: "text", text: billingHeader });
    }

    // CC 2.1.98 sends only {"type":"ephemeral"} — no scope or ttl fields.
    blocks.push({
        type: "text",
        text: CLAUDE_CODE_IDENTITY_STRING,
        cache_control: { type: "ephemeral" },
    });
    blocks.push(...filtered);

    return blocks;
}
