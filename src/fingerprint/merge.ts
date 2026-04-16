import { loadCandidateManifest, loadVerifiedManifest } from "./loader.js";
import { DEFAULT_FALLBACK_PROFILE, mergeManifests } from "./schema.js";
import type { MergeConfig, RequestProfile } from "./types.js";

const DEFAULT_RUNTIME_MERGE_CONFIG: MergeConfig = {
    preferVerified: true,
    allowCandidateLowRisk: true,
    blockedCandidatePaths: [],
};

function normalizeMergeConfig(config?: Partial<MergeConfig>): MergeConfig {
    return {
        preferVerified: config?.preferVerified ?? DEFAULT_RUNTIME_MERGE_CONFIG.preferVerified,
        allowCandidateLowRisk: config?.allowCandidateLowRisk ?? DEFAULT_RUNTIME_MERGE_CONFIG.allowCandidateLowRisk,
        blockedCandidatePaths: config?.blockedCandidatePaths ?? DEFAULT_RUNTIME_MERGE_CONFIG.blockedCandidatePaths,
    };
}

export function resolveRequestProfile(
    version: string | null | undefined,
    config?: Partial<MergeConfig>,
): RequestProfile {
    const normalizedVersion = version?.trim();
    if (!normalizedVersion) {
        return mergeManifests(null, null, DEFAULT_FALLBACK_PROFILE, normalizeMergeConfig(config));
    }

    return mergeManifests(
        loadCandidateManifest(normalizedVersion),
        loadVerifiedManifest(normalizedVersion),
        DEFAULT_FALLBACK_PROFILE,
        normalizeMergeConfig(config),
    );
}

export { DEFAULT_FALLBACK_PROFILE, mergeManifests };
export type { MergeConfig };
