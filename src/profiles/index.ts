export interface SignatureProfileBetaOverrides {
    add?: string[];
    remove?: string[];
}

export interface SignatureProfileToolConfig {
    toolSearch?: {
        enabled: boolean;
        beta: string;
    };
}

export interface SignatureProfile {
    id: string;
    name: string;
    description: string;
    betaOverrides?: SignatureProfileBetaOverrides;
    toolConfig?: SignatureProfileToolConfig;
}

export const DEFAULT_SIGNATURE_PROFILE_ID = "cc-2.1.107-live-default-2026-04-14";
export const TOOL_SEARCH_SIGNATURE_PROFILE_ID = "cc-2.1.107-live-tool-search-2026-04-14";

const TOOL_SEARCH_REGEX_BETA = "tool_search_tool_regex_20251119";

// Two-profile model:
// - Default stays strict 2.1.107 live parity with no Tool Search beta/config drift.
// - Tool Search is an explicit opt-in profile that enables deferred tool loading and
//   the matching regex beta for supported non-Haiku requests.
const DEFAULT_SIGNATURE_PROFILE: SignatureProfile = {
    id: DEFAULT_SIGNATURE_PROFILE_ID,
    name: "Claude Code 2.1.107 live default",
    description: "Matches the current live 2.1.107 OAuth fingerprint with no extra betas enabled.",
};

const TOOL_SEARCH_SIGNATURE_PROFILE: SignatureProfile = {
    id: TOOL_SEARCH_SIGNATURE_PROFILE_ID,
    name: "Claude Code 2.1.107 tool-search",
    description:
        "Opt-in profile that enables Anthropic Tool Search request shaping with deferred tool loading on supported non-Haiku models.",
    toolConfig: {
        toolSearch: {
            enabled: true,
            beta: TOOL_SEARCH_REGEX_BETA,
        },
    },
};

const SIGNATURE_PROFILES: readonly SignatureProfile[] = [DEFAULT_SIGNATURE_PROFILE, TOOL_SEARCH_SIGNATURE_PROFILE];
const SIGNATURE_PROFILE_MAP = new Map(SIGNATURE_PROFILES.map((profile) => [profile.id, profile]));

export function listSignatureProfiles(): SignatureProfile[] {
    return [...SIGNATURE_PROFILES];
}

export function getDefaultSignatureProfile(): SignatureProfile {
    return DEFAULT_SIGNATURE_PROFILE;
}

export function isKnownSignatureProfile(profileId: string | undefined): boolean {
    return typeof profileId === "string" && SIGNATURE_PROFILE_MAP.has(profileId);
}

export function resolveSignatureProfile(profileId?: string): SignatureProfile {
    if (!profileId) {
        return DEFAULT_SIGNATURE_PROFILE;
    }

    const profile = SIGNATURE_PROFILE_MAP.get(profileId);
    if (!profile) {
        throw new Error(`Unknown signature profile: ${profileId}`);
    }

    return profile;
}

export function validateSignatureProfile(profileId: string): string {
    return resolveSignatureProfile(profileId).id;
}
