/**
 * Fingerprint types for the manifest-based request shaping system.
 * Defines the schema for candidate and verified manifests.
 */

// ============================================================================
// Field Metadata and Classification
// ============================================================================

/** Risk classification for fields based on their sensitivity */
export type FieldRisk = "critical" | "sensitive" | "low-risk";

/** Origin/source of a field value */
export type FieldOrigin = "bundle-string" | "bundle-heuristic" | "known-stable" | "live-verified";

/** Confidence level in a field value */
export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

/**
 * Metadata for an individual field including value, risk, origin, and confidence.
 * All fields in manifests carry this metadata for traceability.
 */
export interface FieldMetadata<T> {
    /** The actual field value */
    value: T;
    /** Risk classification */
    risk: FieldRisk;
    /** Source of the value */
    origin: FieldOrigin;
    /** Confidence in the value */
    confidence: ConfidenceLevel;
    /** When the value was extracted (ISO timestamp) */
    extractedAt?: string;
    /** When the value was verified (ISO timestamp) */
    verifiedAt?: string;
}

// ============================================================================
// Request-Shaping Domain Types
// ============================================================================

/** Transport configuration - path style, headers, auth mode */
export interface TransportConfig {
    /** URL path style (e.g., "/v1/messages?beta=true") */
    pathStyle: FieldMetadata<string>;
    /** Default headers required for all requests */
    defaultHeaders: FieldMetadata<Record<string, string>>;
    /** Authentication header mode */
    authHeaderMode: FieldMetadata<string>;
}

/** Header profile - User-Agent, app headers, session headers */
export interface HeaderProfile {
    /** User-Agent string template */
    userAgent: FieldMetadata<string>;
    /** X-App header value */
    xApp: FieldMetadata<string>;
    /** X-Stainless-* headers */
    xStainlessHeaders: FieldMetadata<Record<string, string>>;
    /** Per-request ID header */
    xClientRequestId: FieldMetadata<string>;
    /** Session ID header */
    xClaudeCodeSessionId: FieldMetadata<string>;
}

/** Beta composition - required, optional, and auth-mode betas */
export interface BetaComposition {
    /** Betas always required */
    requiredBaseBetas: FieldMetadata<string[]>;
    /** Optional betas for tools/SDKs */
    optionalBetas: FieldMetadata<string[]>;
    /** Betas specific to auth mode */
    authModeBetas: FieldMetadata<string[]>;
}

/** Billing and attribution configuration */
export interface BillingAttribution {
    /** Claude Code version for billing */
    ccVersion: FieldMetadata<string>;
    /** Entry point identifier */
    ccEntrypoint: FieldMetadata<string>;
    /** CCH (Claude Code Hash) strategy */
    cchStrategy: FieldMetadata<string>;
}

/** Request body schema defaults */
export interface BodySchema {
    /** Default stream setting */
    defaultStream: FieldMetadata<boolean>;
    /** Default max_tokens value */
    defaultMaxTokens: FieldMetadata<number>;
    /** Whether temperature field is present */
    temperaturePresence: FieldMetadata<boolean>;
    /** Whether thinking key is present */
    thinkingKey: FieldMetadata<boolean>;
    /** Whether context_management key is present */
    contextManagementKey: FieldMetadata<boolean>;
    /** Whether tools key is present */
    toolsKey: FieldMetadata<boolean>;
}

/** Prompt strategy configuration */
export interface PromptStrategy {
    /** Identity string variant */
    identityString: FieldMetadata<string>;
    /** Where to place billing block */
    billingBlockPlacement: FieldMetadata<"prepend" | "append">;
    /** Whether to use append mode for system prompts */
    appendMode: FieldMetadata<boolean>;
    /** Cache control behavior */
    cacheControlBehavior: FieldMetadata<string>;
}

/** Metadata and session semantics */
export interface MetadataSemantics {
    /** Shape of metadata.user_id */
    userIdShape: FieldMetadata<string>;
    /** Device linkage strategy */
    deviceLinkage: FieldMetadata<string>;
    /** Account linkage strategy */
    accountLinkage: FieldMetadata<string>;
}

// ============================================================================
// Manifest Types
// ============================================================================

/** Source information for a candidate manifest */
export interface ManifestSource {
    /** NPM package name */
    npmPackage: string;
    /** Tarball download URL */
    tarballUrl: string;
    /** SHA256 hash of tarball */
    tarballHash: string;
    /** ISO timestamp of extraction */
    extractionTimestamp: string;
}

/**
 * Candidate manifest - represents static evidence inferred from npm bundle.
 * Contains all request-shaping fields with metadata about their origin and confidence.
 */
export interface CandidateManifest {
    /** Claude Code version */
    version: string;
    /** Source information */
    source: ManifestSource;
    /** Transport configuration */
    transport: TransportConfig;
    /** Header profile */
    headers: HeaderProfile;
    /** Beta composition */
    betas: BetaComposition;
    /** Billing configuration */
    billing: BillingAttribution;
    /** Body schema */
    body: BodySchema;
    /** Prompt strategy */
    prompt: PromptStrategy;
    /** Metadata semantics */
    metadata: MetadataSemantics;
    /** Parser warnings */
    parserWarnings: string[];
    /** Unknown fields detected */
    unknownFields: string[];
}

/** A field that has been verified through live capture */
export interface VerifiedField {
    /** JSON path to the field */
    path: string;
    /** The verified value */
    value: unknown;
    /** When verified (ISO timestamp) */
    verifiedAt: string;
    /** Who/what verified it (machine label) */
    verifiedBy: string;
    /** Scenarios used for verification */
    scenarioIds: string[];
    /** Reference to evidence artifact */
    evidenceRef?: string;
}

/** A candidate field that was rejected during verification */
export interface RejectedField {
    /** JSON path to the field */
    path: string;
    /** The candidate value that was rejected */
    candidateValue: unknown;
    /** Reason for rejection */
    rejectionReason: string;
    /** Specific mismatches by scenario */
    mismatches: Array<{
        scenarioId: string;
        expected: unknown;
        actual: unknown;
    }>;
}

/**
 * Verified manifest - represents fields confirmed by live capture.
 * Contains only fields that passed verification, plus rejected fields for audit.
 */
export interface VerifiedManifest {
    /** Claude Code version */
    version: string;
    /** When verification completed (ISO timestamp) */
    verifiedAt: string;
    /** Who/what performed verification (machine label) */
    verifiedBy: string;
    /** Scenarios used for verification */
    scenarioIds: string[];
    /** Fields promoted from candidate to verified */
    promotedFields: VerifiedField[];
    /** Candidate fields that failed verification */
    rejectedCandidateFields: RejectedField[];
    /** Paths to evidence artifacts */
    evidenceArtifacts: string[];
}

// ============================================================================
// Index Types
// ============================================================================

/** Entry in a manifest index */
export interface ManifestIndexEntry {
    /** Version string */
    version: string;
    /** Path to manifest file */
    path: string;
    /** When created (ISO timestamp) */
    createdAt: string;
}

/** Index of available manifests */
export interface ManifestIndex {
    /** Schema version */
    schemaVersion: string;
    /** Last update time (ISO timestamp) */
    lastUpdated: string;
    /** Available versions */
    versions: ManifestIndexEntry[];
    /** Latest version (null if none) */
    latest: string | null;
}

// ============================================================================
// Runtime Types
// ============================================================================

/** Configuration for merging manifests */
export interface MergeConfig {
    /** Whether to prefer verified values over candidate */
    preferVerified: boolean;
    /** Whether to allow low-risk candidate fields */
    allowCandidateLowRisk: boolean;
    /** Paths that should never use candidate values */
    blockedCandidatePaths: string[];
}

/**
 * Runtime request profile - the result of merging manifests.
 * This is what the plugin actually uses for request shaping.
 */
export interface RequestProfile {
    /** Version being used */
    version: string;
    /** Source of the manifest data */
    manifestSource: "verified" | "candidate" | "fallback";
    /** Transport configuration */
    transport: TransportConfig;
    /** Header profile */
    headers: HeaderProfile;
    /** Beta composition */
    betas: BetaComposition;
    /** Billing configuration */
    billing: BillingAttribution;
    /** Body schema */
    body: BodySchema;
    /** Prompt strategy */
    prompt: PromptStrategy;
    /** Metadata semantics */
    metadata: MetadataSemantics;
}

// ============================================================================
// Verification Types
// ============================================================================

/** A verification scenario for live capture testing */
export interface VerificationScenario {
    /** Unique scenario ID */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what this scenario tests */
    description: string;
    /** The prompt to send */
    prompt: string;
    /** Expected behavior description */
    expectedBehavior: string;
    /** Fields this scenario is designed to verify */
    requiredFields: string[];
}

/** Result of running a verification scenario */
export interface ScenarioResult {
    /** Scenario ID */
    scenarioId: string;
    /** Whether the scenario passed */
    passed: boolean;
    /** Captured OG Claude Code request */
    ogCapture: unknown;
    /** Captured plugin request */
    pluginCapture: unknown;
    /** Field-by-field comparison results */
    fieldResults: Array<{
        path: string;
        ogValue: unknown;
        pluginValue: unknown;
        match: boolean;
        severity: "critical" | "warning" | "info";
    }>;
    /** Error message if scenario failed */
    error?: string;
}

/** Complete verification report */
export interface VerificationReport {
    /** Version being verified */
    version: string;
    /** When verification ran */
    verifiedAt: string;
    /** Who/what ran verification */
    verifiedBy: string;
    /** Results for each scenario */
    scenarioResults: ScenarioResult[];
    /** Summary statistics */
    summary: {
        totalScenarios: number;
        passedScenarios: number;
        failedScenarios: number;
        totalFields: number;
        matchingFields: number;
        mismatchedFields: number;
    };
}
