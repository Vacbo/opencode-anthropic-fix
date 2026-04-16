import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCandidateManifest, validateVerifiedManifest } from "./schema.js";
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

function readJsonFile(path: string): unknown | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
        return null;
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

export function loadManifestIndex(tier: ManifestTier, options?: ManifestLoaderOptions): ManifestIndex | null {
    const cacheKey = getCacheKey("index", tier, undefined, options);
    if (manifestIndexCache.has(cacheKey)) {
        return manifestIndexCache.get(cacheKey) ?? null;
    }

    const raw = readJsonFile(getManifestIndexPath(tier, options));
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

    const raw = readJsonFile(getManifestPath("candidate", normalizedVersion, options));
    let manifest: CandidateManifest | null = null;

    if (raw !== null) {
        try {
            manifest = validateCandidateManifest(raw);
        } catch {
            manifest = null;
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

    const raw = readJsonFile(getManifestPath("verified", normalizedVersion, options));
    let manifest: VerifiedManifest | null = null;

    if (raw !== null) {
        try {
            manifest = validateVerifiedManifest(raw);
        } catch {
            manifest = null;
        }
    }

    verifiedManifestCache.set(cacheKey, manifest);
    return manifest;
}
