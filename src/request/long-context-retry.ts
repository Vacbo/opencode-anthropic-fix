const LONG_CONTEXT_ERROR_MARKERS = [
    "Extra usage is required for long context requests",
    "long context beta is not yet available",
    "long_context_beta",
] as const;

const LONG_CONTEXT_EXCLUSION_ORDER = [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
] as const;

export type LongContextExcludableBeta = (typeof LONG_CONTEXT_EXCLUSION_ORDER)[number];

const excludedByModel = new Map<string, Set<LongContextExcludableBeta>>();

export function isLongContextError(responseBody: string | null | undefined): boolean {
    if (!responseBody) return false;
    return LONG_CONTEXT_ERROR_MARKERS.some((marker) => responseBody.includes(marker));
}

export function getLongContextExclusions(model: string): ReadonlySet<LongContextExcludableBeta> {
    return excludedByModel.get(model) ?? (new Set() as Set<LongContextExcludableBeta>);
}

export function recordLongContextExclusion(model: string, beta: LongContextExcludableBeta): void {
    const current = excludedByModel.get(model);
    if (current) {
        current.add(beta);
        return;
    }
    excludedByModel.set(model, new Set([beta]));
}

export function nextLongContextExclusion(model: string): LongContextExcludableBeta | null {
    const excluded = excludedByModel.get(model);
    for (const beta of LONG_CONTEXT_EXCLUSION_ORDER) {
        if (!excluded?.has(beta)) return beta;
    }
    return null;
}

export function clearLongContextExclusions(model?: string): void {
    if (model == null) {
        excludedByModel.clear();
        return;
    }
    excludedByModel.delete(model);
}
