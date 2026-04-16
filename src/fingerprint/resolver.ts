import { clearManifestLoaderCache, getLatestVersion, loadCandidateManifest, loadVerifiedManifest } from "./loader.js";
import type { ManifestLoaderOptions } from "./loader.js";
import { DEFAULT_FALLBACK_PROFILE, mergeManifests } from "./merge.js";
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

function buildCacheKey(version: string | null, config: MergeConfig): string {
    return JSON.stringify({ version, config });
}

function resolveVersion(version: string | null | undefined, loaderOptions?: ManifestLoaderOptions): string | null {
    const normalizedVersion = version?.trim();
    if (normalizedVersion) {
        const hasRequestedManifest =
            loadVerifiedManifest(normalizedVersion, loaderOptions) !== null ||
            loadCandidateManifest(normalizedVersion, loaderOptions) !== null;
        if (hasRequestedManifest) {
            return normalizedVersion;
        }
    }

    return getLatestVersion("verified", loaderOptions) ?? getLatestVersion("candidate", loaderOptions) ?? null;
}

export class ProfileResolver {
    #cache = new Map<string, RequestProfile>();
    #activeCacheKey: string | null = null;
    #loaderOptions: ManifestLoaderOptions;

    constructor(loaderOptions: ManifestLoaderOptions = {}) {
        this.#loaderOptions = loaderOptions;
    }

    resolveProfile(version?: string | null, config?: Partial<MergeConfig>): RequestProfile {
        const normalizedConfig = normalizeMergeConfig(config);
        const resolvedVersion = resolveVersion(version, this.#loaderOptions);
        const cacheKey = buildCacheKey(resolvedVersion, normalizedConfig);
        const cached = this.#cache.get(cacheKey);

        if (cached) {
            this.#activeCacheKey = cacheKey;
            return cached;
        }

        const profile = resolvedVersion
            ? mergeManifests(
                  loadCandidateManifest(resolvedVersion, this.#loaderOptions),
                  loadVerifiedManifest(resolvedVersion, this.#loaderOptions),
                  DEFAULT_FALLBACK_PROFILE,
                  normalizedConfig,
              )
            : mergeManifests(null, null, DEFAULT_FALLBACK_PROFILE, normalizedConfig);

        this.#cache.set(cacheKey, profile);
        this.#activeCacheKey = cacheKey;
        return profile;
    }

    getActiveProfile(version?: string | null, config?: Partial<MergeConfig>): RequestProfile {
        if (this.#activeCacheKey && version === undefined && config === undefined) {
            const cached = this.#cache.get(this.#activeCacheKey);
            if (cached) {
                return cached;
            }
        }

        return this.resolveProfile(version, config);
    }

    refresh(): void {
        this.#cache.clear();
        this.#activeCacheKey = null;
        clearManifestLoaderCache();
    }
}

const profileResolver = new ProfileResolver();

export function resolveProfile(version?: string | null, config?: Partial<MergeConfig>): RequestProfile {
    return profileResolver.resolveProfile(version, config);
}

export function getActiveProfile(version?: string | null, config?: Partial<MergeConfig>): RequestProfile {
    return profileResolver.getActiveProfile(version, config);
}
