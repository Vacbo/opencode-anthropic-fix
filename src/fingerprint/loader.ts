import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManifestValidationError, validateCandidateManifest, validateVerifiedManifest } from "./schema.js";
import type { CandidateManifest, ManifestIndex, VerifiedManifest } from "./types.js";

export type ManifestTier = "candidate" | "verified";

export interface ManifestLoaderOptions {
    manifestRoot?: string;
}

const MANIFEST_ROOT_ENV = "OPENCODE_ANTHROPIC_MANIFEST_ROOT";

const candidateManifestCache = new Map<string, CandidateManifest | null>();
const verifiedManifestCache = new Map<string, VerifiedManifest | null>();
const manifestIndexCache = new Map<string, ManifestIndex | null>();

function getDefaultManifestRoot(): string {
    return fileURLToPath(new URL("../../manifests/", import.meta.url));
}

function getManifestRoot(options?: ManifestLoaderOptions): string {
    const override = options?.manifestRoot?.trim() || process.env[MANIFEST_ROOT_ENV]?.trim();
    return resolve(override || getDefaultManifestRoot());
}

function getManifestIndexPath(tier: ManifestTier, options?: ManifestLoaderOptions): string {
    return resolve(getManifestRoot(options), tier, "claude-code", "index.json");
}

function getManifestPath(tier: ManifestTier, version: string, options?: ManifestLoaderOptions): string {
    return resolve(getManifestRoot(options), tier, "claude-code", `${version}.json`);
}

// Returns null for ENOENT, throws ManifestValidationError for malformed JSON so
// callers do not silently negative-cache files that exist but are corrupt.
function readJsonFile(path: string): unknown | null {
    if (!existsSync(path)) {
        return null;
    }

    let raw: string;
    try {
        raw = readFileSync(path, "utf-8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        throw new ManifestValidationError(`Failed to read manifest file: ${path}`, { cause: error });
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new ManifestValidationError(`Manifest file contains invalid JSON: ${path}`, { cause: error });
    }
}

function isManifestIndex(value: unknown): value is ManifestIndex {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.schemaVersion === "string" &&
        typeof candidate.lastUpdated === "string" &&
        (candidate.latest === null || typeof candidate.latest === "string") &&
        Array.isArray(candidate.versions)
    );
}

function getCacheKey(
    kind: "manifest" | "index",
    tier: ManifestTier,
    version?: string,
    options?: ManifestLoaderOptions,
): string {
    return `${getManifestRoot(options)}:${kind}:${tier}:${version ?? "index"}`;
}

export function clearManifestLoaderCache(): void {
    candidateManifestCache.clear();
    verifiedManifestCache.clear();
    manifestIndexCache.clear();
}

function logManifestValidationFailure(
    tier: ManifestTier,
    subject: "index" | string,
    error: ManifestValidationError,
): void {
    const rootCause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    // eslint-disable-next-line no-console -- operator diagnostic: surfaces corrupt-manifest fallback cause at load time
    console.warn(`[opencode-anthropic-auth] manifest validation failed (${tier}/${subject}): ${error.message}${rootCause}`);
}

export function loadManifestIndex(tier: ManifestTier, options?: ManifestLoaderOptions): ManifestIndex | null {
    const cacheKey = getCacheKey("index", tier, undefined, options);
    if (manifestIndexCache.has(cacheKey)) {
        return manifestIndexCache.get(cacheKey) ?? null;
    }

    let raw: unknown | null;
    try {
        raw = readJsonFile(getManifestIndexPath(tier, options));
    } catch (error) {
        if (error instanceof ManifestValidationError) {
            logManifestValidationFailure(tier, "index", error);
            return null;
        }
        throw error;
    }

    const index = isManifestIndex(raw) ? raw : null;
    manifestIndexCache.set(cacheKey, index);
    return index;
}

export function getLatestVersion(tier: ManifestTier, options?: ManifestLoaderOptions): string | null {
    return loadManifestIndex(tier, options)?.latest ?? null;
}

export function loadCandidateManifest(version: string, options?: ManifestLoaderOptions): CandidateManifest | null {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
        return null;
    }

    const cacheKey = getCacheKey("manifest", "candidate", normalizedVersion, options);
    if (candidateManifestCache.has(cacheKey)) {
        return candidateManifestCache.get(cacheKey) ?? null;
    }

    let manifest: CandidateManifest | null = null;
    try {
        const raw = readJsonFile(getManifestPath("candidate", normalizedVersion, options));
        if (raw !== null) {
            manifest = validateCandidateManifest(raw);
        }
    } catch (error) {
        if (error instanceof ManifestValidationError) {
            logManifestValidationFailure("candidate", normalizedVersion, error);
            manifest = null;
        } else {
            throw error;
        }
    }

    candidateManifestCache.set(cacheKey, manifest);
    return manifest;
}

export function loadVerifiedManifest(version: string, options?: ManifestLoaderOptions): VerifiedManifest | null {
    const normalizedVersion = version.trim();
    if (!normalizedVersion) {
        return null;
    }

    const cacheKey = getCacheKey("manifest", "verified", normalizedVersion, options);
    if (verifiedManifestCache.has(cacheKey)) {
        return verifiedManifestCache.get(cacheKey) ?? null;
    }

    let manifest: VerifiedManifest | null = null;
    try {
        const raw = readJsonFile(getManifestPath("verified", normalizedVersion, options));
        if (raw !== null) {
            manifest = validateVerifiedManifest(raw);
        }
    } catch (error) {
        if (error instanceof ManifestValidationError) {
            logManifestValidationFailure("verified", normalizedVersion, error);
            manifest = null;
        } else {
            throw error;
        }
    }

    verifiedManifestCache.set(cacheKey, manifest);
    return manifest;
}
