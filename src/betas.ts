import {
    ADVANCED_TOOL_USE_BETA_FLAG,
    BEDROCK_UNSUPPORTED_BETAS,
    BETA_SHORTCUTS,
    CLAUDE_CODE_BETA_FLAG,
    EFFORT_BETA_FLAG,
    EXPERIMENTAL_BETA_FLAGS,
    TOKEN_COUNTING_BETA_FLAG,
} from "./constants.js";
import type { RequestProfile } from "./fingerprint/types.ts";
import { isTruthyEnv } from "./env.js";
import { getLatestVersion, loadCandidateManifest } from "./fingerprint/loader.ts";
import {
    hasOneMillionContext,
    isAdaptiveThinkingModel,
    isHaikuModel,
    supportsContextManagement,
    supportsStructuredOutputs,
    supportsThinking,
    supportsWebSearch,
} from "./models.js";
import type { SignatureProfile } from "./profiles/index.js";
import { getRequestProfile } from "./request/profile-resolver.js";
import { getLongContextExclusions } from "./request/long-context-retry.js";
import type { AccountSelectionStrategy, Provider } from "./types.js";

const ADVISOR_TOOL_BETA_FLAG = "advisor-tool-2026-03-01";
const CONTEXT_1M_BETA_FLAG = "context-1m-2025-08-07";

function parseBetaList(raw: string): string[] {
    return raw
        .split(",")
        .map((beta) => beta.trim())
        .filter(Boolean);
}

function getOptionalBetaInventory(requestProfile: RequestProfile): string[] {
    if (requestProfile.manifestSource !== "fallback" && requestProfile.betas.optionalBetas.value.length > 0) {
        return requestProfile.betas.optionalBetas.value.filter(Boolean);
    }

    const version = requestProfile.version.trim();
    if (!version || version === "unknown") {
        return [];
    }

    const directCandidate = loadCandidateManifest(version)?.betas.optionalBetas.value.filter(Boolean);
    if (directCandidate && directCandidate.length > 0) {
        return directCandidate;
    }

    const latestCandidateVersion = getLatestVersion("candidate");
    if (!latestCandidateVersion || latestCandidateVersion === version) {
        return [];
    }

    return loadCandidateManifest(latestCandidateVersion)?.betas.optionalBetas.value.filter(Boolean) ?? [];
}

function getAuthModeBetaInventory(requestProfile: RequestProfile): string[] {
    if (requestProfile.manifestSource !== "fallback" && requestProfile.betas.authModeBetas.value.length > 0) {
        return requestProfile.betas.authModeBetas.value.filter(Boolean);
    }

    const version = requestProfile.version.trim();
    if (!version || version === "unknown") {
        return [];
    }

    const directCandidate = loadCandidateManifest(version)?.betas.authModeBetas.value.filter(Boolean);
    if (directCandidate && directCandidate.length > 0) {
        return directCandidate;
    }

    const latestCandidateVersion = getLatestVersion("candidate");
    if (!latestCandidateVersion || latestCandidateVersion === version) {
        return [];
    }

    return loadCandidateManifest(latestCandidateVersion)?.betas.authModeBetas.value.filter(Boolean) ?? [];
}

function applyProfileBetaOverrides(betas: string[], profile: SignatureProfile | undefined): string[] {
    if (!profile?.betaOverrides) {
        return betas;
    }

    let nextBetas = [...betas];
    if (Array.isArray(profile.betaOverrides.add)) {
        nextBetas.push(...profile.betaOverrides.add.filter(Boolean));
    }
    if (Array.isArray(profile.betaOverrides.remove) && profile.betaOverrides.remove.length > 0) {
        const removals = new Set(profile.betaOverrides.remove);
        nextBetas = nextBetas.filter((beta) => !removals.has(beta));
    }

    return nextBetas;
}

function profileEnablesToolSearch(profile: SignatureProfile | undefined, model: string): boolean {
    return profile?.toolConfig?.toolSearch?.enabled === true && !isHaikuModel(model);
}

function getToolSearchBeta(profile: SignatureProfile | undefined, model: string): string | undefined {
    if (!profileEnablesToolSearch(profile, model)) {
        return undefined;
    }

    return profile?.toolConfig?.toolSearch?.beta;
}

export function buildAnthropicBetaHeader(
    incomingBeta: string,
    signatureEnabled: boolean,
    model: string,
    provider: Provider,
    customBetas: string[] | undefined,
    strategy: AccountSelectionStrategy | undefined,
    requestPath: string | undefined,
    hasFileReferences: boolean,
    profile?: SignatureProfile,
    hasDeferredToolLoading = false,
    claudeCliVersion?: string,
    requestProfile?: RequestProfile,
): string {
    const resolvedRequestProfile = requestProfile ?? getRequestProfile({ version: claudeCliVersion });
    const incomingBetasList = signatureEnabled ? [] : parseBetaList(incomingBeta);

    const requiredBaseBetas = resolvedRequestProfile.betas.requiredBaseBetas.value.filter(Boolean);
    const manifestOptionalBetas = getOptionalBetaInventory(resolvedRequestProfile);
    const manifestOptionalBetaSet = new Set(manifestOptionalBetas);
    const authModeBetas = getAuthModeBetaInventory(resolvedRequestProfile);

    const betas: string[] = [];
    const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
    const isMessagesEndpoint = requestPath === "/v1/messages";
    const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
    const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;
    const isFirstPartyProvider = provider === "anthropic" || provider === "foundry";

    if (!signatureEnabled) {
        if (requiredBaseBetas.length > 0) {
            betas.push(...requiredBaseBetas);
        }
        betas.push("interleaved-thinking-2025-05-14");
        if (isMessagesCountTokensPath) {
            betas.push(TOKEN_COUNTING_BETA_FLAG);
        }
        let mergedBetas = [...new Set([...betas, ...incomingBetasList])];
        if (disableExperimentalBetas) {
            mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
        }
        return mergedBetas.join(",");
    }

    const haiku = isHaikuModel(model);
    const isRoundRobin = strategy === "round-robin";

    if (!haiku) {
        betas.push(CLAUDE_CODE_BETA_FLAG);
    }

    if (isFirstPartyProvider) {
        betas.push(...requiredBaseBetas);
        if (authModeBetas.length > 0) {
            betas.push(...authModeBetas);
        }
    }

    // Signature emulation owns the beta header. We intentionally ignore raw incoming
    // values here and only add explicitly modeled runtime, profile, env, or user betas.

    const toolSearchBeta = getToolSearchBeta(profile, model);
    if (toolSearchBeta && hasDeferredToolLoading) {
        betas.push(toolSearchBeta);
    }

    if ((isFilesEndpoint || hasFileReferences) && !disableExperimentalBetas) {
        betas.push("files-api-2025-04-14");
    }

    if (
        !disableExperimentalBetas &&
        isMessagesEndpoint &&
        isFirstPartyProvider &&
        manifestOptionalBetaSet.has(CONTEXT_1M_BETA_FLAG) &&
        hasOneMillionContext(model)
    ) {
        betas.push(CONTEXT_1M_BETA_FLAG);
    }

    if (
        !disableExperimentalBetas &&
        !isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) &&
        (supportsThinking(model) || isAdaptiveThinkingModel(model))
    ) {
        betas.push("interleaved-thinking-2025-05-14");
    }

    if (!disableExperimentalBetas && supportsContextManagement(model)) {
        betas.push("context-management-2025-06-27");
    }

    if (!disableExperimentalBetas && supportsStructuredOutputs(model) && isTruthyEnv(process.env.TENGU_TOOL_PEAR)) {
        betas.push("structured-outputs-2025-12-15");
    }

    if (!disableExperimentalBetas && (provider === "vertex" || provider === "foundry") && supportsWebSearch(model)) {
        betas.push("web-search-2025-03-05");
    }

    if (!disableExperimentalBetas && !isRoundRobin) {
        betas.push("prompt-caching-scope-2026-01-05");
    }

    if (!disableExperimentalBetas && isMessagesEndpoint && isFirstPartyProvider && !haiku) {
        if (manifestOptionalBetaSet.has(ADVISOR_TOOL_BETA_FLAG)) {
            betas.push(ADVISOR_TOOL_BETA_FLAG);
        }
        if (manifestOptionalBetaSet.has(ADVANCED_TOOL_USE_BETA_FLAG)) {
            betas.push(ADVANCED_TOOL_USE_BETA_FLAG);
        }
    }

    if (isAdaptiveThinkingModel(model)) {
        betas.push(EFFORT_BETA_FLAG);
    }

    if (isMessagesCountTokensPath) {
        betas.push(TOKEN_COUNTING_BETA_FLAG);
    }

    if (process.env.ANTHROPIC_BETAS) {
        const envBetas = parseBetaList(process.env.ANTHROPIC_BETAS);
        betas.push(...envBetas);
    }

    if (Array.isArray(customBetas)) {
        betas.push(...customBetas.filter(Boolean));
    }

    const profileBetas = applyProfileBetaOverrides(betas, profile);

    let mergedBetas = [...new Set([...profileBetas, ...incomingBetasList])];
    if (disableExperimentalBetas) {
        mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
    }
    const longContextExclusions = getLongContextExclusions(model);
    if (longContextExclusions.size > 0) {
        mergedBetas = mergedBetas.filter((beta) => !longContextExclusions.has(beta as never));
    }
    if (provider === "bedrock") {
        return mergedBetas.filter((beta) => !BEDROCK_UNSUPPORTED_BETAS.has(beta)).join(",");
    }
    return mergedBetas.join(",");
}

/**
 * Resolve a beta shortcut alias to its full beta name.
 * Falls back to the original value if no shortcut is found.
 */
export function resolveBetaShortcut(value: string | undefined): string {
    if (!value) return "";
    const trimmed = value.trim();
    const mapped = BETA_SHORTCUTS.get(trimmed.toLowerCase());
    return mapped || trimmed;
}
