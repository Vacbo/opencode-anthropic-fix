/**
 * Fingerprint schema validation and merge logic.
 * Implements field classification, validation, and manifest merging.
 */

import type {
    CandidateManifest,
    VerifiedManifest,
    RequestProfile,
    MergeConfig,
    FieldMetadata,
    FieldRisk,
    FieldOrigin,
    ConfidenceLevel,
    VerificationScenario,
    TransportConfig,
    HeaderProfile,
    BetaComposition,
    BillingAttribution,
    BodySchema,
    PromptStrategy,
    MetadataSemantics,
} from "./types.js";

// ============================================================================
// Risk Classification
// ============================================================================

/**
 * Critical field paths that affect authentication, identity, or billing.
 * These must never use candidate-only data without explicit allowlisting.
 */
const CRITICAL_PATHS: string[] = [
    "transport.authHeaderMode",
    "betas.requiredBaseBetas",
    "betas.authModeBetas",
    "headers.userAgent",
    "headers.xApp",
    "billing.ccEntrypoint",
    "metadata.userIdShape",
    "prompt.identityString",
    "prompt.billingBlockPlacement",
    "prompt.cacheControlBehavior",
    "body.defaultStream",
    "body.defaultMaxTokens",
];

/**
 * Sensitive field paths that affect request fingerprinting.
 * These should prefer verified values but can use candidate with caution.
 */
const SENSITIVE_PATHS: string[] = [
    "headers.xStainlessHeaders",
    "headers.xClientRequestId",
    "headers.xClaudeCodeSessionId",
    "betas.optionalBetas",
    "transport.defaultHeaders",
    "transport.pathStyle",
];

/**
 * Classify a field path by risk level.
 * @param fieldPath - Dot-notation path to the field
 * @returns Risk classification
 */
export function classifyRisk(fieldPath: string): FieldRisk {
    if (CRITICAL_PATHS.some((p) => fieldPath === p || fieldPath.startsWith(p + "."))) {
        return "critical";
    }
    if (SENSITIVE_PATHS.some((p) => fieldPath === p || fieldPath.startsWith(p + "."))) {
        return "sensitive";
    }
    return "low-risk";
}

/**
 * Validate a complete candidate manifest.
 * @throws Error if manifest is invalid
 */
export function validateCandidateManifest(manifest: unknown): CandidateManifest {
    if (typeof manifest !== "object" || manifest === null) {
        throw new Error("Candidate manifest must be an object");
    }

    const cm = manifest as Record<string, unknown>;

    // Required top-level fields
    const requiredFields = [
        "version",
        "source",
        "transport",
        "headers",
        "betas",
        "billing",
        "body",
        "prompt",
        "metadata",
    ];
    for (const field of requiredFields) {
        if (!(field in cm)) {
            throw new Error(`Candidate manifest missing required field: ${field}`);
        }
    }

    // Validate version is string
    if (typeof cm.version !== "string") {
        throw new Error("Candidate manifest version must be a string");
    }

    // Validate arrays
    if (!Array.isArray(cm.parserWarnings)) {
        throw new Error("Candidate manifest parserWarnings must be an array");
    }
    if (!Array.isArray(cm.unknownFields)) {
        throw new Error("Candidate manifest unknownFields must be an array");
    }

    return manifest as CandidateManifest;
}

/**
 * Validate a verified manifest.
 * @throws Error if manifest is invalid
 */
export function validateVerifiedManifest(manifest: unknown): VerifiedManifest {
    if (typeof manifest !== "object" || manifest === null) {
        throw new Error("Verified manifest must be an object");
    }

    const vm = manifest as Record<string, unknown>;

    // Required top-level fields
    const requiredFields = [
        "version",
        "verifiedAt",
        "verifiedBy",
        "scenarioIds",
        "promotedFields",
        "rejectedCandidateFields",
        "evidenceArtifacts",
    ];
    for (const field of requiredFields) {
        if (!(field in vm)) {
            throw new Error(`Verified manifest missing required field: ${field}`);
        }
    }

    // Validate version is string
    if (typeof vm.version !== "string") {
        throw new Error("Verified manifest version must be a string");
    }

    // Validate arrays
    if (!Array.isArray(vm.scenarioIds)) {
        throw new Error("Verified manifest scenarioIds must be an array");
    }
    if (!Array.isArray(vm.promotedFields)) {
        throw new Error("Verified manifest promotedFields must be an array");
    }
    if (!Array.isArray(vm.rejectedCandidateFields)) {
        throw new Error("Verified manifest rejectedCandidateFields must be an array");
    }
    if (!Array.isArray(vm.evidenceArtifacts)) {
        throw new Error("Verified manifest evidenceArtifacts must be an array");
    }

    return manifest as VerifiedManifest;
}

// ============================================================================
// Merge Logic
// ============================================================================

/**
 * Default fallback request profile.
 * Used when no manifests are available.
 */
export const DEFAULT_FALLBACK_PROFILE: RequestProfile = {
    version: "unknown",
    manifestSource: "fallback",
    transport: {
        pathStyle: {
            value: "/v1/messages?beta=true",
            risk: "sensitive",
            origin: "known-stable",
            confidence: "high",
        },
        defaultHeaders: {
            value: { "content-type": "application/json" },
            risk: "low-risk",
            origin: "known-stable",
            confidence: "high",
        },
        authHeaderMode: {
            value: "bearer",
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
    },
    headers: {
        userAgent: {
            value: "claude-cli/unknown",
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
        xApp: {
            value: "claude-cli",
            risk: "sensitive",
            origin: "known-stable",
            confidence: "high",
        },
        xStainlessHeaders: {
            value: {},
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
        xClientRequestId: {
            value: "x-client-request-id",
            risk: "sensitive",
            origin: "known-stable",
            confidence: "high",
        },
        xClaudeCodeSessionId: {
            value: "X-Claude-Code-Session-Id",
            risk: "sensitive",
            origin: "known-stable",
            confidence: "high",
        },
    },
    betas: {
        requiredBaseBetas: {
            value: ["oauth-2025-04-20"],
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        optionalBetas: {
            value: [],
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
        authModeBetas: {
            value: [],
            risk: "critical",
            origin: "known-stable",
            confidence: "medium",
        },
    },
    billing: {
        ccVersion: {
            value: "unknown",
            risk: "critical",
            origin: "known-stable",
            confidence: "medium",
        },
        ccEntrypoint: {
            value: "claude-cli",
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        cchStrategy: {
            value: "xxhash64",
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
    },
    body: {
        defaultStream: {
            value: true,
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        defaultMaxTokens: {
            value: 4096,
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        temperaturePresence: {
            value: false,
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
        thinkingKey: {
            value: true,
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
        contextManagementKey: {
            value: true,
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
        toolsKey: {
            value: true,
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
    },
    prompt: {
        identityString: {
            value: "You are Claude Code, Anthropic's official CLI for Claude.",
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        billingBlockPlacement: {
            value: "prepend",
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        appendMode: {
            value: false,
            risk: "critical",
            origin: "known-stable",
            confidence: "medium",
        },
        cacheControlBehavior: {
            value: "default",
            risk: "sensitive",
            origin: "known-stable",
            confidence: "medium",
        },
    },
    metadata: {
        userIdShape: {
            value: "oauth:<account_id>",
            risk: "critical",
            origin: "known-stable",
            confidence: "high",
        },
        deviceLinkage: {
            value: "default",
            risk: "low-risk",
            origin: "known-stable",
            confidence: "low",
        },
        accountLinkage: {
            value: "default",
            risk: "low-risk",
            origin: "known-stable",
            confidence: "low",
        },
    },
};

/**
 * Resolve a single field value using precedence rules.
 * Precedence: verified > candidate (if allowed) > fallback
 */
export function resolveField<T>(
    verifiedValue: T | undefined,
    candidateField: FieldMetadata<T> | undefined,
    fallbackValue: T,
    config: MergeConfig,
): T {
    // 1. Use verified value if available
    if (verifiedValue !== undefined) {
        return verifiedValue;
    }

    // 2. Check if candidate is available and allowed
    if (candidateField !== undefined && candidateField.value !== undefined) {
        const fieldPath = "unknown"; // Would need to track path through recursion
        const risk = candidateField.risk;
        const isBlocked = config.blockedCandidatePaths.some((p) => fieldPath.startsWith(p));

        // Critical fields never use candidate-only data
        if (risk === "critical") {
            return fallbackValue;
        }

        // Sensitive fields only if explicitly allowed
        if (risk === "sensitive" && !config.preferVerified) {
            return fallbackValue;
        }

        // Low-risk fields can use candidate if allowed
        if (risk === "low-risk" && config.allowCandidateLowRisk && !isBlocked) {
            return candidateField.value;
        }

        // Default to fallback for safety
        return fallbackValue;
    }

    // 3. Fall back to default
    return fallbackValue;
}

/**
 * Merge field metadata from multiple sources.
 */
function mergeFieldMetadata<T>(
    verified: FieldMetadata<T> | undefined,
    candidate: FieldMetadata<T> | undefined,
    fallback: FieldMetadata<T>,
    config: MergeConfig,
    fieldPath: string,
): FieldMetadata<T> {
    const risk = verified?.risk ?? candidate?.risk ?? fallback.risk;

    // Determine which value to use
    let selectedValue: T;
    let selectedOrigin: FieldOrigin;
    let selectedConfidence: ConfidenceLevel;

    if (verified !== undefined && config.preferVerified) {
        // Use verified value
        selectedValue = verified.value;
        selectedOrigin = "live-verified";
        selectedConfidence = "high";
    } else if (candidate !== undefined) {
        const isBlocked = config.blockedCandidatePaths.some((p) => fieldPath.startsWith(p));

        if (risk === "critical" || isBlocked) {
            // Never use candidate for critical fields
            selectedValue = fallback.value;
            selectedOrigin = fallback.origin;
            selectedConfidence = fallback.confidence;
        } else if (risk === "sensitive") {
            // Sensitive fields require live verification. Candidate inventory is useful
            // for CI and reports, but should not shape runtime requests.
            selectedValue = fallback.value;
            selectedOrigin = fallback.origin;
            selectedConfidence = fallback.confidence;
        } else {
            // Low-risk: use candidate if allowed
            if (config.allowCandidateLowRisk) {
                selectedValue = candidate.value;
                selectedOrigin = candidate.origin;
                selectedConfidence = candidate.confidence;
            } else {
                selectedValue = fallback.value;
                selectedOrigin = fallback.origin;
                selectedConfidence = fallback.confidence;
            }
        }
    } else {
        // No candidate, use fallback
        selectedValue = fallback.value;
        selectedOrigin = fallback.origin;
        selectedConfidence = fallback.confidence;
    }

    return {
        value: selectedValue,
        risk,
        origin: selectedOrigin,
        confidence: selectedConfidence,
    };
}

/**
 * Merge transport configuration.
 */
function mergeTransport(
    candidate: TransportConfig | undefined,
    verified: VerifiedManifest | null,
    fallback: TransportConfig,
    config: MergeConfig,
): TransportConfig {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "critical", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        pathStyle: mergeFieldMetadata(
            getVerifiedField("transport.pathStyle"),
            candidate?.pathStyle,
            fallback.pathStyle,
            config,
            "transport.pathStyle",
        ),
        defaultHeaders: mergeFieldMetadata(
            getVerifiedField("transport.defaultHeaders"),
            candidate?.defaultHeaders,
            fallback.defaultHeaders,
            config,
            "transport.defaultHeaders",
        ),
        authHeaderMode: mergeFieldMetadata(
            getVerifiedField("transport.authHeaderMode"),
            candidate?.authHeaderMode,
            fallback.authHeaderMode,
            config,
            "transport.authHeaderMode",
        ),
    };
}

/**
 * Merge header profile.
 */
function mergeHeaders(
    candidate: HeaderProfile | undefined,
    verified: VerifiedManifest | null,
    fallback: HeaderProfile,
    config: MergeConfig,
): HeaderProfile {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "sensitive", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        userAgent: mergeFieldMetadata(
            getVerifiedField("headers.userAgent"),
            candidate?.userAgent,
            fallback.userAgent,
            config,
            "headers.userAgent",
        ),
        xApp: mergeFieldMetadata(
            getVerifiedField("headers.xApp"),
            candidate?.xApp,
            fallback.xApp,
            config,
            "headers.xApp",
        ),
        xStainlessHeaders: mergeFieldMetadata(
            getVerifiedField("headers.xStainlessHeaders"),
            candidate?.xStainlessHeaders,
            fallback.xStainlessHeaders,
            config,
            "headers.xStainlessHeaders",
        ),
        xClientRequestId: mergeFieldMetadata(
            getVerifiedField("headers.xClientRequestId"),
            candidate?.xClientRequestId,
            fallback.xClientRequestId,
            config,
            "headers.xClientRequestId",
        ),
        xClaudeCodeSessionId: mergeFieldMetadata(
            getVerifiedField("headers.xClaudeCodeSessionId"),
            candidate?.xClaudeCodeSessionId,
            fallback.xClaudeCodeSessionId,
            config,
            "headers.xClaudeCodeSessionId",
        ),
    };
}

/**
 * Merge beta composition.
 */
function mergeBetas(
    candidate: BetaComposition | undefined,
    verified: VerifiedManifest | null,
    fallback: BetaComposition,
    config: MergeConfig,
): BetaComposition {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "critical", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        requiredBaseBetas: mergeFieldMetadata(
            getVerifiedField("betas.requiredBaseBetas"),
            candidate?.requiredBaseBetas,
            fallback.requiredBaseBetas,
            config,
            "betas.requiredBaseBetas",
        ),
        optionalBetas: mergeFieldMetadata(
            getVerifiedField("betas.optionalBetas"),
            candidate?.optionalBetas,
            fallback.optionalBetas,
            config,
            "betas.optionalBetas",
        ),
        authModeBetas: mergeFieldMetadata(
            getVerifiedField("betas.authModeBetas"),
            candidate?.authModeBetas,
            fallback.authModeBetas,
            config,
            "betas.authModeBetas",
        ),
    };
}

/**
 * Merge billing configuration.
 */
function mergeBilling(
    candidate: BillingAttribution | undefined,
    verified: VerifiedManifest | null,
    fallback: BillingAttribution,
    config: MergeConfig,
): BillingAttribution {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "critical", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        ccVersion: mergeFieldMetadata(
            getVerifiedField("billing.ccVersion"),
            candidate?.ccVersion,
            fallback.ccVersion,
            config,
            "billing.ccVersion",
        ),
        ccEntrypoint: mergeFieldMetadata(
            getVerifiedField("billing.ccEntrypoint"),
            candidate?.ccEntrypoint,
            fallback.ccEntrypoint,
            config,
            "billing.ccEntrypoint",
        ),
        cchStrategy: mergeFieldMetadata(
            getVerifiedField("billing.cchStrategy"),
            candidate?.cchStrategy,
            fallback.cchStrategy,
            config,
            "billing.cchStrategy",
        ),
    };
}

/**
 * Merge body schema.
 */
function mergeBody(
    candidate: BodySchema | undefined,
    verified: VerifiedManifest | null,
    fallback: BodySchema,
    config: MergeConfig,
): BodySchema {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "critical", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        defaultStream: mergeFieldMetadata(
            getVerifiedField("body.defaultStream"),
            candidate?.defaultStream,
            fallback.defaultStream,
            config,
            "body.defaultStream",
        ),
        defaultMaxTokens: mergeFieldMetadata(
            getVerifiedField("body.defaultMaxTokens"),
            candidate?.defaultMaxTokens,
            fallback.defaultMaxTokens,
            config,
            "body.defaultMaxTokens",
        ),
        temperaturePresence: mergeFieldMetadata(
            getVerifiedField("body.temperaturePresence"),
            candidate?.temperaturePresence,
            fallback.temperaturePresence,
            config,
            "body.temperaturePresence",
        ),
        thinkingKey: mergeFieldMetadata(
            getVerifiedField("body.thinkingKey"),
            candidate?.thinkingKey,
            fallback.thinkingKey,
            config,
            "body.thinkingKey",
        ),
        contextManagementKey: mergeFieldMetadata(
            getVerifiedField("body.contextManagementKey"),
            candidate?.contextManagementKey,
            fallback.contextManagementKey,
            config,
            "body.contextManagementKey",
        ),
        toolsKey: mergeFieldMetadata(
            getVerifiedField("body.toolsKey"),
            candidate?.toolsKey,
            fallback.toolsKey,
            config,
            "body.toolsKey",
        ),
    };
}

/**
 * Merge prompt strategy.
 */
function mergePrompt(
    candidate: PromptStrategy | undefined,
    verified: VerifiedManifest | null,
    fallback: PromptStrategy,
    config: MergeConfig,
): PromptStrategy {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "critical", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        identityString: mergeFieldMetadata(
            getVerifiedField("prompt.identityString"),
            candidate?.identityString,
            fallback.identityString,
            config,
            "prompt.identityString",
        ),
        billingBlockPlacement: mergeFieldMetadata(
            getVerifiedField("prompt.billingBlockPlacement"),
            candidate?.billingBlockPlacement,
            fallback.billingBlockPlacement,
            config,
            "prompt.billingBlockPlacement",
        ),
        appendMode: mergeFieldMetadata(
            getVerifiedField("prompt.appendMode"),
            candidate?.appendMode,
            fallback.appendMode,
            config,
            "prompt.appendMode",
        ),
        cacheControlBehavior: mergeFieldMetadata(
            getVerifiedField("prompt.cacheControlBehavior"),
            candidate?.cacheControlBehavior,
            fallback.cacheControlBehavior,
            config,
            "prompt.cacheControlBehavior",
        ),
    };
}

/**
 * Merge metadata semantics.
 */
function mergeMetadata(
    candidate: MetadataSemantics | undefined,
    verified: VerifiedManifest | null,
    fallback: MetadataSemantics,
    config: MergeConfig,
): MetadataSemantics {
    const getVerifiedField = <T>(path: string): FieldMetadata<T> | undefined => {
        if (!verified) return undefined;
        const field = verified.promotedFields.find((f) => f.path === path);
        return field
            ? { value: field.value as T, risk: "critical", origin: "live-verified", confidence: "high" }
            : undefined;
    };

    return {
        userIdShape: mergeFieldMetadata(
            getVerifiedField("metadata.userIdShape"),
            candidate?.userIdShape,
            fallback.userIdShape,
            config,
            "metadata.userIdShape",
        ),
        deviceLinkage: mergeFieldMetadata(
            getVerifiedField("metadata.deviceLinkage"),
            candidate?.deviceLinkage,
            fallback.deviceLinkage,
            config,
            "metadata.deviceLinkage",
        ),
        accountLinkage: mergeFieldMetadata(
            getVerifiedField("metadata.accountLinkage"),
            candidate?.accountLinkage,
            fallback.accountLinkage,
            config,
            "metadata.accountLinkage",
        ),
    };
}

/**
 * Merge candidate and verified manifests into a runtime request profile.
 * Implements precedence: verified > candidate (if allowed) > fallback
 */
export function mergeManifests(
    candidate: CandidateManifest | null,
    verified: VerifiedManifest | null,
    fallback: RequestProfile = DEFAULT_FALLBACK_PROFILE,
    config: MergeConfig = { preferVerified: true, allowCandidateLowRisk: false, blockedCandidatePaths: [] },
): RequestProfile {
    // Determine manifest source
    let manifestSource: "verified" | "candidate" | "fallback" = "fallback";
    if (verified && verified.promotedFields.length > 0) {
        manifestSource = "verified";
    } else if (candidate && config.allowCandidateLowRisk) {
        manifestSource = "candidate";
    }

    // Determine version
    const version = verified?.version ?? candidate?.version ?? fallback.version;

    return {
        version,
        manifestSource,
        transport: mergeTransport(candidate?.transport, verified, fallback.transport, config),
        headers: mergeHeaders(candidate?.headers, verified, fallback.headers, config),
        betas: mergeBetas(candidate?.betas, verified, fallback.betas, config),
        billing: mergeBilling(candidate?.billing, verified, fallback.billing, config),
        body: mergeBody(candidate?.body, verified, fallback.body, config),
        prompt: mergePrompt(candidate?.prompt, verified, fallback.prompt, config),
        metadata: mergeMetadata(candidate?.metadata, verified, fallback.metadata, config),
    };
}

// ============================================================================
// Verification Scenarios
// ============================================================================

/**
 * Standard verification scenarios for live capture testing.
 */
export const VERIFICATION_SCENARIOS: VerificationScenario[] = [
    {
        id: "minimal-hi",
        name: "Minimal Greeting",
        description: "Basic greeting request to verify core request shape",
        prompt: "hi",
        expectedBehavior: "Simple text response with standard headers and body format",
        requiredFields: [
            "transport.pathStyle",
            "headers.userAgent",
            "headers.xApp",
            "betas.requiredBaseBetas",
            "body.defaultStream",
        ],
    },
    {
        id: "tool-search",
        name: "Tool Search",
        description: "Request with tool use to verify tool-related headers and body fields",
        prompt: "Search for files matching *.ts in the current directory",
        expectedBehavior: "Tool use request with proper tool definitions in body",
        requiredFields: ["body.toolsKey", "betas.optionalBetas", "headers.xStainlessHeaders"],
    },
    {
        id: "append-system-prompt",
        name: "Append System Prompt",
        description: "Request with system prompt to verify prompt handling",
        prompt: "Explain how system prompts work",
        expectedBehavior: "Response acknowledging system prompt context",
        requiredFields: [
            "prompt.identityString",
            "prompt.billingBlockPlacement",
            "prompt.appendMode",
            "metadata.userIdShape",
        ],
    },
    {
        id: "oauth-token-refresh",
        name: "OAuth Token Refresh",
        description: "OAuth flow to verify auth-specific headers and betas",
        prompt: "",
        expectedBehavior: "Token refresh with proper OAuth headers and betas",
        requiredFields: [
            "transport.authHeaderMode",
            "betas.authModeBetas",
            "billing.ccEntrypoint",
            "billing.cchStrategy",
        ],
    },
];

/**
 * Get a verification scenario by ID.
 */
export function getScenario(id: string): VerificationScenario | undefined {
    return VERIFICATION_SCENARIOS.find((s) => s.id === id);
}

/**
 * Get all verification scenario IDs.
 */
export function getScenarioIds(): string[] {
    return VERIFICATION_SCENARIOS.map((s) => s.id);
}
