import { FALLBACK_CLAUDE_CLI_VERSION } from "../constants.js";
import { clearManifestLoaderCache } from "../fingerprint/loader.js";
import type { ManifestLoaderOptions } from "../fingerprint/loader.js";
import { DEFAULT_FALLBACK_PROFILE } from "../fingerprint/merge.js";
import { ProfileResolver as FingerprintProfileResolver } from "../fingerprint/resolver.js";
import type { MergeConfig, RequestProfile } from "../fingerprint/types.js";
import { buildUserAgent, getClaudeEntrypoint } from "../headers/user-agent.js";

export interface RequestProfileOptions {
    version?: string | null;
    mergeConfig?: Partial<MergeConfig>;
    forceRefresh?: boolean;
}

function buildCacheKey(options: RequestProfileOptions): string {
    return JSON.stringify({
        version: options.version ?? null,
        mergeConfig: options.mergeConfig ?? null,
    });
}

function normalizeCliVersion(profile: RequestProfile, requestedVersion?: string | null): string {
    const requested = requestedVersion?.trim();
    const profileVersion = profile.billing.ccVersion.value;

    if (requested) {
        return requested;
    }

    if (profileVersion && profileVersion !== DEFAULT_FALLBACK_PROFILE.billing.ccVersion.value) {
        return profileVersion;
    }

    return FALLBACK_CLAUDE_CLI_VERSION;
}

function normalizeUserAgent(profile: RequestProfile, cliVersion: string): string {
    const value = profile.headers.userAgent.value;
    if (!value || value === DEFAULT_FALLBACK_PROFILE.headers.userAgent.value) {
        return buildUserAgent(cliVersion);
    }
    return value;
}

function normalizeXApp(profile: RequestProfile): string {
    const value = profile.headers.xApp.value;
    if (!value || value === DEFAULT_FALLBACK_PROFILE.headers.xApp.value) {
        return "cli";
    }
    return value;
}

function normalizeEntrypoint(profile: RequestProfile): string {
    const value = profile.billing.ccEntrypoint.value;
    if (!value || value === DEFAULT_FALLBACK_PROFILE.billing.ccEntrypoint.value) {
        return getClaudeEntrypoint();
    }
    return value;
}

function normalizeRequestProfile(profile: RequestProfile, requestedVersion?: string | null): RequestProfile {
    const cliVersion = normalizeCliVersion(profile, requestedVersion);
    const requested = requestedVersion?.trim();

    return {
        ...profile,
        version: requested || (profile.version === DEFAULT_FALLBACK_PROFILE.version ? cliVersion : profile.version),
        transport: {
            ...profile.transport,
            defaultHeaders: {
                ...profile.transport.defaultHeaders,
                value: {
                    "content-type": "application/json",
                    ...profile.transport.defaultHeaders.value,
                },
            },
        },
        headers: {
            ...profile.headers,
            userAgent: {
                ...profile.headers.userAgent,
                value: normalizeUserAgent(profile, cliVersion),
            },
            xApp: {
                ...profile.headers.xApp,
                value: normalizeXApp(profile),
            },
            xClientRequestId: {
                ...profile.headers.xClientRequestId,
                value:
                    profile.headers.xClientRequestId.value || DEFAULT_FALLBACK_PROFILE.headers.xClientRequestId.value,
            },
            xClaudeCodeSessionId: {
                ...profile.headers.xClaudeCodeSessionId,
                value:
                    profile.headers.xClaudeCodeSessionId.value ||
                    DEFAULT_FALLBACK_PROFILE.headers.xClaudeCodeSessionId.value,
            },
        },
        billing: {
            ...profile.billing,
            ccVersion: {
                ...profile.billing.ccVersion,
                value: cliVersion,
            },
            ccEntrypoint: {
                ...profile.billing.ccEntrypoint,
                value: normalizeEntrypoint(profile),
            },
        },
    };
}

export class RequestProfileResolver {
    #cache = new Map<string, RequestProfile>();
    #fingerprintResolver: FingerprintProfileResolver;

    constructor(loaderOptions: ManifestLoaderOptions = {}) {
        this.#fingerprintResolver = new FingerprintProfileResolver(loaderOptions);
    }

    getRequestProfile(options: RequestProfileOptions = {}): RequestProfile {
        const cacheKey = buildCacheKey(options);

        if (!options.forceRefresh) {
            const cached = this.#cache.get(cacheKey);
            if (cached) {
                return cached;
            }
        }

        const profile = normalizeRequestProfile(
            this.#fingerprintResolver.resolveProfile(options.version, options.mergeConfig),
            options.version,
        );

        this.#cache.set(cacheKey, profile);
        return profile;
    }

    refreshProfile(options: RequestProfileOptions = {}): RequestProfile {
        this.#cache.clear();
        clearManifestLoaderCache();
        this.#fingerprintResolver.refresh();
        return this.getRequestProfile({ ...options, forceRefresh: true });
    }
}

export const ProfileResolver = new RequestProfileResolver();

export function getRequestProfile(options: RequestProfileOptions = {}): RequestProfile {
    return ProfileResolver.getRequestProfile(options);
}

export function refreshProfile(options: RequestProfileOptions = {}): RequestProfile {
    return ProfileResolver.refreshProfile(options);
}
