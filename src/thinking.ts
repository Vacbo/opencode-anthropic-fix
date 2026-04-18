// ---------------------------------------------------------------------------
// Thinking block normalization extracted from src/index.ts
// ---------------------------------------------------------------------------

import { isAdaptiveThinkingModel } from "./models.js";
import type { ThinkingEffort } from "./types.js";

export interface NormalizedThinkingConfig {
    thinking: unknown;
    outputConfig?: Record<string, unknown>;
}

/**
 * Map budgetTokens to an effort level.
 * Used when an Opus 4.6 request arrives with the legacy budgetTokens shape.
 */
export function budgetTokensToEffort(budgetTokens: number): ThinkingEffort {
    if (budgetTokens <= 1024) return "low";
    if (budgetTokens <= 8000) return "medium";
    return "high";
}

/**
 * Validate that a given value is a valid ThinkingEffort string.
 */
export function isValidEffort(value: unknown): value is ThinkingEffort {
    return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

/**
 * Normalise the request thinking configuration for the target model.
 * Adaptive-thinking models emit the real Claude wire shape:
 *   - `thinking: { type: "adaptive" }`
 *   - `output_config.effort: <effort>`
 * Older/manual-budget models pass the existing thinking block through unchanged.
 *
 * Handles three incoming shapes:
 *   1. Already effort-based: `{ type: "enabled", effort: "..." }` → kept as-is for Opus 4.6
 *   2. Legacy manual: `{ type: "enabled", budget_tokens: N }` → mapped to effort for Opus 4.6
 *   3. Absent / disabled: no transform
 */
export function normalizeThinkingConfig(
    thinking: unknown,
    outputConfig: Record<string, unknown> | undefined,
    model: string,
): NormalizedThinkingConfig {
    if (!thinking || typeof thinking !== "object") {
        return { thinking, outputConfig };
    }

    const t = thinking as Record<string, unknown>;
    if (t.type !== "enabled" && t.type !== "adaptive") {
        return { thinking, outputConfig };
    }

    if (!isAdaptiveThinkingModel(model)) {
        return { thinking, outputConfig };
    }

    const effort: ThinkingEffort = isValidEffort(t.effort)
        ? t.effort
        : isValidEffort(outputConfig?.effort)
          ? outputConfig.effort
          : typeof t.budget_tokens === "number"
            ? budgetTokensToEffort(t.budget_tokens)
            : "medium";

    return {
        thinking: { type: "adaptive" },
        outputConfig: { ...(outputConfig ?? {}), effort },
    };
}

export function normalizeThinkingBlock(thinking: unknown, model: string): unknown {
    return normalizeThinkingConfig(thinking, undefined, model).thinking;
}
