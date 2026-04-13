import type { AccountSelectionStrategy, HealthScoreConfig, TokenBucketConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";

export interface AccountCandidate {
    index: number;
    lastUsed: number;
    healthScore: number;
    isRateLimited: boolean;
    enabled: boolean;
}

// --- Health Score Tracker ---

export class HealthScoreTracker {
    #scores = new Map<number, { score: number; lastUpdated: number; consecutiveFailures: number }>();
    #config: HealthScoreConfig;

    constructor(config: Partial<HealthScoreConfig> = {}) {
        this.#config = { ...DEFAULT_CONFIG.health_score, ...config };
    }

    /**
     * Get the current health score for an account, including passive recovery.
     */
    getScore(accountIndex: number): number {
        const state = this.#scores.get(accountIndex);
        if (!state) return this.#config.initial;

        const hoursSinceUpdate = (Date.now() - state.lastUpdated) / (1000 * 60 * 60);
        const recoveredPoints = Math.floor(hoursSinceUpdate * this.#config.recovery_rate_per_hour);

        return Math.min(this.#config.max_score, state.score + recoveredPoints);
    }

    /**
     * Record a successful request.
     */
    recordSuccess(accountIndex: number): void {
        const current = this.getScore(accountIndex);
        this.#scores.set(accountIndex, {
            score: Math.min(this.#config.max_score, current + this.#config.success_reward),
            lastUpdated: Date.now(),
            consecutiveFailures: 0,
        });
    }

    /**
     * Record a rate limit event.
     */
    recordRateLimit(accountIndex: number): void {
        const current = this.getScore(accountIndex);
        const state = this.#scores.get(accountIndex);
        this.#scores.set(accountIndex, {
            score: Math.max(0, current + this.#config.rate_limit_penalty),
            lastUpdated: Date.now(),
            consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
        });
    }

    /**
     * Record a general failure.
     */
    recordFailure(accountIndex: number): void {
        const current = this.getScore(accountIndex);
        const state = this.#scores.get(accountIndex);
        this.#scores.set(accountIndex, {
            score: Math.max(0, current + this.#config.failure_penalty),
            lastUpdated: Date.now(),
            consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
        });
    }

    /**
     * Check if an account is usable (score above minimum).
     */
    isUsable(accountIndex: number): boolean {
        return this.getScore(accountIndex) >= this.#config.min_usable;
    }

    /**
     * Reset tracking for an account.
     */
    reset(accountIndex: number): void {
        this.#scores.delete(accountIndex);
    }
}

// --- Token Bucket Tracker ---

export class TokenBucketTracker {
    #buckets = new Map<number, { tokens: number; lastUpdated: number }>();
    #config: TokenBucketConfig;

    constructor(config: Partial<TokenBucketConfig> = {}) {
        this.#config = { ...DEFAULT_CONFIG.token_bucket, ...config };
    }

    /**
     * Get current token count for an account, including regeneration.
     */
    getTokens(accountIndex: number): number {
        const state = this.#buckets.get(accountIndex);
        if (!state) return this.#config.initial_tokens;

        const minutesSinceUpdate = (Date.now() - state.lastUpdated) / (1000 * 60);
        const recoveredTokens = minutesSinceUpdate * this.#config.regeneration_rate_per_minute;

        return Math.min(this.#config.max_tokens, state.tokens + recoveredTokens);
    }

    /**
     * Check if an account has enough tokens.
     */
    hasTokens(accountIndex: number, cost = 1): boolean {
        return this.getTokens(accountIndex) >= cost;
    }

    /**
     * Consume tokens for a request.
     * @returns Whether tokens were available and consumed
     */
    consume(accountIndex: number, cost = 1): boolean {
        const current = this.getTokens(accountIndex);
        if (current < cost) return false;

        this.#buckets.set(accountIndex, {
            tokens: current - cost,
            lastUpdated: Date.now(),
        });
        return true;
    }

    /**
     * Refund tokens (e.g., on non-rate-limit failure).
     */
    refund(accountIndex: number, amount = 1): void {
        const current = this.getTokens(accountIndex);
        this.#buckets.set(accountIndex, {
            tokens: Math.min(this.#config.max_tokens, current + amount),
            lastUpdated: Date.now(),
        });
    }

    /**
     * Get the max tokens value (for scoring calculations).
     */
    getMaxTokens(): number {
        return this.#config.max_tokens;
    }
}

// --- Selection Algorithms ---

const STICKINESS_BONUS = 150;
const SWITCH_THRESHOLD = 100;

function calculateHybridScore(account: AccountCandidate & { tokens: number }, maxTokens: number): number {
    const healthComponent = account.healthScore * 2;
    const tokenComponent = (account.tokens / maxTokens) * 100 * 5;
    const secondsSinceUsed = (Date.now() - account.lastUsed) / 1000;
    const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;

    return Math.max(0, healthComponent + tokenComponent + freshnessComponent);
}

/**
 * Select the best account based on the configured strategy.
 */
export function selectAccount(
    candidates: AccountCandidate[],
    strategy: AccountSelectionStrategy,
    currentIndex: number | null,
    healthTracker: HealthScoreTracker,
    tokenTracker: TokenBucketTracker,
    cursor: number,
): { index: number; cursor: number } | null {
    const available = candidates.filter((acc) => acc.enabled && !acc.isRateLimited);

    if (available.length === 0) return null;

    switch (strategy) {
        case "sticky": {
            if (currentIndex !== null) {
                const current = available.find((acc) => acc.index === currentIndex);
                if (current) {
                    return { index: current.index, cursor };
                }
            }
            const next = available[cursor % available.length];
            return next ? { index: next.index, cursor: cursor + 1 } : null;
        }

        case "round-robin": {
            const next = available[cursor % available.length];
            return next ? { index: next.index, cursor: cursor + 1 } : null;
        }

        case "hybrid": {
            const scoredCandidates = available
                .filter((acc) => healthTracker.isUsable(acc.index) && tokenTracker.hasTokens(acc.index))
                .map((acc) => ({
                    ...acc,
                    tokens: tokenTracker.getTokens(acc.index),
                }));

            if (scoredCandidates.length === 0) {
                const fallback = available[0];
                return fallback ? { index: fallback.index, cursor } : null;
            }

            const maxTokens = tokenTracker.getMaxTokens();
            const scored = scoredCandidates
                .map((acc) => {
                    const baseScore = calculateHybridScore(acc, maxTokens);
                    const stickinessBonus = acc.index === currentIndex ? STICKINESS_BONUS : 0;
                    return {
                        index: acc.index,
                        baseScore,
                        score: baseScore + stickinessBonus,
                        isCurrent: acc.index === currentIndex,
                    };
                })
                .sort((a, b) => b.score - a.score);

            const best = scored[0];
            if (!best) return null;

            const currentCandidate = scored.find((s) => s.isCurrent);
            if (currentCandidate && !best.isCurrent) {
                const advantage = best.baseScore - currentCandidate.baseScore;
                if (advantage < SWITCH_THRESHOLD) {
                    return { index: currentCandidate.index, cursor };
                }
            }

            return { index: best.index, cursor };
        }

        default:
            return available[0] ? { index: available[0].index, cursor } : null;
    }
}
