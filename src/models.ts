// ---------------------------------------------------------------------------
// Model detection helpers extracted from src/index.ts
// ---------------------------------------------------------------------------

import type { Provider } from "./types.js";

export function isHaikuModel(model: string): boolean {
    return /haiku/i.test(model);
}

export function supportsThinking(model: string): boolean {
    if (!model) return true;
    return /claude|sonnet|opus|haiku/i.test(model);
}

/**
 * Detects claude-opus-4.6 / claude-opus-4-6 / claude-opus-4-7 model IDs.
 * These models use adaptive thinking (effort parameter) instead of
 * manual budgetTokens.
 *
 * Matches standard IDs (claude-opus-4-6, claude-opus-4.7), Bedrock ARNs
 * (arn:aws:bedrock:...anthropic.claude-opus-4-7-...), and bare fragments
 * ("opus-4-6", "opus-4.7") for non-standard strings.
 *
 * Extend the `[67]` character class when a new adaptive Opus version ships.
 */
export function isOpus46Model(model: string): boolean {
    if (!model) return false;
    return /claude-opus-4[._-][67]|opus[._-]4[._-][67]/i.test(model);
}

/**
 * Detects claude-sonnet-4.6 / claude-sonnet-4-6 / claude-sonnet-4-7 model IDs.
 * Like Opus 4.6+, these models use adaptive thinking (effort parameter).
 *
 * Extend the `[67]` character class when a new adaptive Sonnet version ships.
 */
export function isSonnet46Model(model: string): boolean {
    if (!model) return false;
    return /claude-sonnet-4[._-][67]|sonnet[._-]4[._-][67]/i.test(model);
}

/**
 * Detects models whose Messages API thinking block uses `effort` instead of
 * `budget_tokens`.
 *
 * Real Claude Code Proxyman captures show adaptive thinking for both 4.6 and
 * 4.7 Sonnet/Opus families. The wire shape is `thinking: { type: "adaptive" }`
 * plus `output_config.effort`.
 */
export function isAdaptiveThinkingModel(model: string): boolean {
    if (!model) return false;
    return isOpus46Model(model) || isSonnet46Model(model);
}

export function hasOneMillionContext(model: string): boolean {
    // Models with explicit 1m suffix, or Opus 4.6+ (1M by default since v2.1.75).
    return /(^|[-_ ])1m($|[-_ ])|context[-_]?1m/i.test(model) || isOpus46Model(model);
}

export function supportsStructuredOutputs(model: string): boolean {
    if (!/claude|sonnet|opus|haiku/i.test(model)) return false;
    return !isHaikuModel(model);
}

/**
 * Context management is supported on Claude 4+ models (matches upstream CC).
 */
export function supportsContextManagement(model: string): boolean {
    if (!model) return false;
    // Claude 3.x does not support context management
    if (/claude-3-/i.test(model)) return false;
    // Any other Claude model (4+) supports it
    return /claude|sonnet|opus|haiku/i.test(model);
}

export function supportsWebSearch(model: string): boolean {
    return /claude|sonnet|opus|haiku|gpt|gemini/i.test(model);
}

export function detectProvider(requestUrl: URL | null): Provider {
    if (!requestUrl) return "anthropic";
    const host = requestUrl.hostname.toLowerCase();
    if (host.includes("bedrock") || host.includes("amazonaws.com")) return "bedrock";
    if (host.includes("aiplatform") || host.includes("vertex")) return "vertex";
    if (host.includes("foundry") || host.includes("azure")) return "foundry";
    return "anthropic";
}
