// ---------------------------------------------------------------------------
// Thinking block normalization extracted from index.mjs
// ---------------------------------------------------------------------------

import { isAdaptiveThinkingModel } from "./models.ts";
import type { ThinkingEffort } from "./types.ts";

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
    return value === "low" || value === "medium" || value === "high";
}

/**
 * Normalise the `thinking` block in the request body for the target model:
 * - Opus 4.6 (effort-based thinking): produces `{ type: "enabled", effort: <effort> }`
 * - Older models: passes the existing thinking block through unchanged.
 *
 * Handles three incoming shapes:
 *   1. Already effort-based: `{ type: "enabled", effort: "..." }` → kept as-is for Opus 4.6
 *   2. Legacy manual: `{ type: "enabled", budget_tokens: N }` → mapped to effort for Opus 4.6
 *   3. Absent / disabled: no transform
 */
export function normalizeThinkingBlock(thinking: unknown, model: string): unknown {
    if (!thinking || typeof thinking !== "object" || (thinking as Record<string, unknown>).type !== "enabled") {
        return thinking;
    }

    if (!isAdaptiveThinkingModel(model)) {
        // Older models: pass through unchanged (may have budget_tokens)
        return thinking;
    }

    const t = thinking as Record<string, unknown>;

    // Adaptive thinking models: use adaptive thinking with effort
    if (isValidEffort(t.effort)) {
        // Already in adaptive shape — just strip any legacy budget_tokens field
        const { budget_tokens: _dropped, ...rest } = t;
        return rest;
    }

    const effort: ThinkingEffort =
        typeof t.budget_tokens === "number" ? budgetTokensToEffort(t.budget_tokens) : "medium"; // v2.1.68 default

    return { type: "enabled", effort };
}
