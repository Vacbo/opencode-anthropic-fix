import {
    BEDROCK_UNSUPPORTED_BETAS,
    BETA_SHORTCUTS,
    CLAUDE_CODE_BETA_FLAG,
    EFFORT_BETA_FLAG,
    EXPERIMENTAL_BETA_FLAGS,
    TOKEN_COUNTING_BETA_FLAG,
} from "./constants.js";
import type { RequestProfile } from "./fingerprint/types.ts";
import { isTruthyEnv } from "./env.js";
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
import type { AccountSelectionStrategy, Provider } from "./types.js";

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
    const incomingBetasList = incomingBeta
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);

    const requiredBaseBetas = resolvedRequestProfile.betas.requiredBaseBetas.value.filter(Boolean);
    const manifestOptionalBetas =
        resolvedRequestProfile.manifestSource === "fallback"
            ? []
            : resolvedRequestProfile.betas.optionalBetas.value.filter(Boolean);
    const authModeBetas =
        resolvedRequestProfile.manifestSource === "fallback"
            ? []
            : resolvedRequestProfile.betas.authModeBetas.value.filter(Boolean);

    const betas: string[] = requiredBaseBetas.length > 0 ? [...requiredBaseBetas] : ["oauth-2025-04-20"];
    const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
    const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
    const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;

    if (!signatureEnabled) {
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

    betas.push(...authModeBetas);

    if (!haiku) {
        betas.push(CLAUDE_CODE_BETA_FLAG);
    }

    betas.push(...manifestOptionalBetas);

    const toolSearchBeta = getToolSearchBeta(profile, model);
    if (toolSearchBeta && hasDeferredToolLoading) {
        betas.push(toolSearchBeta);
    }

    // Files API beta is endpoint/content-scoped instead of globally applied.
    if ((isFilesEndpoint || hasFileReferences) && !disableExperimentalBetas) {
        betas.push("files-api-2025-04-14");
    }

    // NOTE: redact-thinking-2026-02-12 is in upstream 2.1.79+ base profile but
    // intentionally NOT auto-included here — OpenCode users benefit from seeing
    // thinking blocks. Available via /anthropic betas add redact-thinking-2026-02-12.

    // CC 2.1.107 capture still does not send these base-profile betas automatically
    // even though they're in the source. Only include when explicitly requested.
    // advanced-tool-use and fast-mode were causing fingerprint mismatch.

    // advisor-tool and managed-agents appear in the extracted 2.1.107 bundle, but
    // live Claude /v1/messages captures do not send them on standard message requests.
    // Keep them opt-in until we see a request-path-specific capture that requires them.

    if (isAdaptiveThinkingModel(model)) {
        // Adaptive thinking models (Opus 4.6, Sonnet 4.6) use effort-based thinking controls.
        betas.push(EFFORT_BETA_FLAG);
    } else if (
        !disableExperimentalBetas &&
        !isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) &&
        supportsThinking(model)
    ) {
        betas.push("interleaved-thinking-2025-05-14");
    }

    // context-1m-2025-08-07 is only supported for API key users; OAuth provider does not support it.
    // For OAuth (this plugin's only auth mode), compaction is gated by model.limit.input instead.
    if (!disableExperimentalBetas && hasOneMillionContext(model) && provider !== "anthropic") {
        betas.push("context-1m-2025-08-07");
    }

    // Context management: upstream CC adds this for Claude 4+ models (thinking
    // preservation) or when ant users opt in via USE_API_CONTEXT_MANAGEMENT.
    if (!disableExperimentalBetas && supportsContextManagement(model)) {
        betas.push("context-management-2025-06-27");
    }

    if (!disableExperimentalBetas && supportsStructuredOutputs(model) && isTruthyEnv(process.env.TENGU_TOOL_PEAR)) {
        betas.push("structured-outputs-2025-12-15");
    }

    if (!disableExperimentalBetas && (provider === "vertex" || provider === "foundry") && supportsWebSearch(model)) {
        betas.push("web-search-2025-03-05");
    }

    // Upstream CC always sends prompt-caching-scope for firstParty providers.
    // Skip in round-robin (zero cache hits, doubled costs).
    if (!disableExperimentalBetas && !isRoundRobin) {
        betas.push("prompt-caching-scope-2026-01-05");
    }

    if (isMessagesCountTokensPath) {
        betas.push(TOKEN_COUNTING_BETA_FLAG);
    }

    if (process.env.ANTHROPIC_BETAS) {
        const envBetas = process.env.ANTHROPIC_BETAS.split(",")
            .map((b) => b.trim())
            .filter(Boolean);
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
