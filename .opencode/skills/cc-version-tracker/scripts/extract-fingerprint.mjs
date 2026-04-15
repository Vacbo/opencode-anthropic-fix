#!/usr/bin/env node
/**
 * extract-fingerprint.mjs — Extract mimicry-relevant data from CC cli.js
 *
 * Usage:
 *   node extract-fingerprint.mjs /tmp/cc-2.1.80/cli.js
 *
 * Outputs JSON fingerprint to stdout and saves to /tmp/cc-fingerprint-VERSION.json
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

function parseArgs(args) {
    let cliPath = null;
    let explicitVersion = null;
    let outPath = null;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === "--version") {
            explicitVersion = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (arg === "--out") {
            outPath = args[i + 1] || null;
            i += 1;
            continue;
        }

        if (!arg.startsWith("--") && cliPath === null) {
            cliPath = arg;
        }
    }

    return { cliPath, explicitVersion, outPath };
}

const { cliPath, explicitVersion, outPath: explicitOutPath } = parseArgs(process.argv.slice(2));
if (!cliPath) {
    console.error("Usage: node extract-fingerprint.mjs <path/to/cli.js>");
    process.exit(1);
}

const resolvedCliPath = resolve(cliPath);
const src = readFileSync(resolvedCliPath, "utf8");

// --- Helpers ---

function findAfter(haystack, needle, maxLen = 200) {
    const idx = haystack.indexOf(needle);
    if (idx === -1) return null;
    return haystack.slice(idx + needle.length, idx + needle.length + maxLen);
}

function extractUUID(str) {
    const m = str.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : null;
}

function extractAllMatches(haystack, pattern, group = 1) {
    const re = new RegExp(pattern, "g");
    const results = [];
    let m = re.exec(haystack);
    while (m !== null) {
        results.push(m[group]);
        m = re.exec(haystack);
    }
    return [...new Set(results)];
}

// --- Version ---
// Look for package version near "version":"X.Y.Z" patterns
function extractVersionFromSource() {
    // Try npm package version field
    const m = src.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
    // Also try CLI_VERSION or VERSION constants
    const m2 = src.match(/CLI_VERSION\s*[=:]\s*["'](\d+\.\d+\.\d+)["']/);
    return m2?.[1] || m?.[1] || "unknown";
}

function extractVersionFromPackageJson() {
    const packageJsonPath = resolve(dirname(resolvedCliPath), "package.json");
    if (!existsSync(packageJsonPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        return typeof parsed.version === "string" ? parsed.version : null;
    } catch {
        return null;
    }
}

function extractVersionFromPath() {
    const m = resolvedCliPath.match(/(?:^|[^\d])(\d+\.\d+\.\d+)(?:[^\d]|$)/);
    return m?.[1] || null;
}

function resolveVersion() {
    return explicitVersion || extractVersionFromPackageJson() || extractVersionFromPath() || extractVersionFromSource();
}

// --- Client IDs ---
function extractClientIds() {
    const result = {};

    // Prod client ID near CLIENT_ID
    const afterProd =
        findAfter(src, 'CLIENT_ID:"', 80) || findAfter(src, "CLIENT_ID:'", 80) || findAfter(src, "CLIENT_ID`", 80);
    if (afterProd) {
        const uuid = extractUUID(afterProd);
        if (uuid) result.prod = uuid;
    }

    // Also search for all UUIDs near "client_id" context
    const clientIdCtx = [];
    let searchPos = 0;
    while (true) {
        const idx = src.indexOf("client_id", searchPos);
        if (idx === -1) break;
        clientIdCtx.push(src.slice(idx, idx + 120));
        searchPos = idx + 1;
        if (clientIdCtx.length > 20) break;
    }

    const allUUIDs = new Set();
    for (const ctx of clientIdCtx) {
        const uuid = extractUUID(ctx);
        if (uuid) allUUIDs.add(uuid);
    }

    // Staging typically differs from prod
    const uuids = [...allUUIDs];
    if (!result.prod && uuids[0]) result.prod = uuids[0];
    if (uuids[1]) result.staging = uuids[1];

    // Direct search for known patterns
    const prodMatch = src.match(/9d1c250a-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (prodMatch) result.prod = prodMatch[0];
    const stagingMatch = src.match(/22422756-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (stagingMatch) result.staging = stagingMatch[0];

    return result;
}

// --- Scopes ---
function extractScopes() {
    // Scopes appear as string literals near "scope" or as an array. We look for
    // the known `user:` and `org:` prefixes inline in the regex below.
    const scopes = extractAllMatches(src, /["']((?:user|org):[a-z_:]+)["']/);
    return scopes.sort();
}

// --- Endpoints ---
function extractEndpoints() {
    const endpoints = {};

    // Authorize URL
    const authorizeCtx = findAfter(src, "authorize", 300);
    if (authorizeCtx) {
        const url = authorizeCtx.match(/["'](https:\/\/[^"']+auth[^"']*)["']/);
        if (url) endpoints.authorize = url[1];
    }

    // Token URL
    const tokenCtx = findAfter(src, "/oauth/token", 100);
    if (tokenCtx) endpoints.token = "/oauth/token";

    // API base
    const apiBase = src.match(/["'](https:\/\/api\.anthropic\.com\/v\d+)["']/);
    if (apiBase) endpoints.api = apiBase[1];

    // Auth base
    const authBase = src.match(/["'](https:\/\/(?:auth|console)\.anthropic\.com[^"']*)["']/);
    if (authBase) endpoints.authBase = authBase[1];

    return endpoints;
}

// --- Axios version ---
function extractAxiosVersion() {
    // axios/X.Y.Z appears in User-Agent construction
    const m = src.match(/axios\/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

// --- SDK version ---
function extractSdkVersion() {
    // x-stainless-package-version header value
    const ctx = findAfter(src, "stainless-package-version", 100) || findAfter(src, "X-Stainless-Package-Version", 100);
    if (ctx) {
        const m = ctx.match(/["'](\d+\.\d+\.\d+)["']/);
        if (m) return m[1];
    }
    // Fallback: @anthropic-ai/sdk version
    const m2 = src.match(/@anthropic-ai\/sdk[^"']*["'](\d+\.\d+\.\d+)["']/);
    return m2 ? m2[1] : null;
}

// --- Billing ---
function extractBilling() {
    const result = {};

    // cch= prefix in billing header
    const cchCtx = findAfter(src, "cch=", 60);
    if (cchCtx) {
        const m = cchCtx.match(/^([0-9a-f]{4,8})/i);
        if (m) result.cch = m[1];
    }

    // Salt for billing hash
    const saltCtx = findAfter(src, "x-anthropic-billing-header", 300);
    if (saltCtx) {
        // Salt is typically a hex string ~12 chars
        const saltMatch = saltCtx.match(/["']([0-9a-f]{10,16})["']/);
        if (saltMatch) result.salt = saltMatch[1];
    }

    // Hash positions (array of indices used in hash computation)
    const posCtx = findAfter(src, "hashPositions", 100) || findAfter(src, "hash_positions", 100);
    if (posCtx) {
        const arrMatch = posCtx.match(/\[([0-9,\s]+)\]/);
        if (arrMatch) {
            result.hashPositions = arrMatch[1]
                .split(",")
                .map((n) => parseInt(n.trim(), 10))
                .filter(Boolean);
        }
    }

    return result;
}

// --- Betas ---
function extractBetas() {
    const result = { always: [], conditional: [], bedrockUnsupported: [] };

    // Beta strings near "anthropic-beta" header
    const betaValues = extractAllMatches(src, /["']([\w-]+-\d{4}-\d{2}-\d{2}(?:-[\w-]+)?)["']/);
    // Filter to likely beta flag format: word-YYYY-MM-DD
    const betaFlags = betaValues.filter((v) => /^\w[\w-]+-\d{4}-\d{2}-\d{2}/.test(v));

    result.always = betaFlags;

    // Bedrock-unsupported betas (near "bedrock" context)
    const bedrockCtx = src.indexOf("bedrock");
    if (bedrockCtx !== -1) {
        const bedrockSlice = src.slice(bedrockCtx, bedrockCtx + 2000);
        result.bedrockUnsupported = extractAllMatches(bedrockSlice, /["']([\w-]+-\d{4}-\d{2}-\d{2})["']/);
    }

    return result;
}

// --- User-Agent format ---
function extractUserAgentFormat() {
    const ctx = findAfter(src, "claude-cli/", 200);
    if (!ctx) return null;
    // Capture the format string up to end of template
    const m = src.match(/["'`](claude-cli\/[^"'`]{5,120})["'`]/);
    return m ? m[1] : "claude-cli/{VER} (external, {entry})";
}

// --- Assemble ---
const version = resolveVersion();
const fingerprint = {
    version,
    clientIds: extractClientIds(),
    scopes: extractScopes(),
    endpoints: extractEndpoints(),
    axiosVersion: extractAxiosVersion(),
    sdkVersion: extractSdkVersion(),
    billing: extractBilling(),
    betas: extractBetas(),
    userAgentFormat: extractUserAgentFormat(),
};

const json = JSON.stringify(fingerprint, null, 2);
const fallbackOutPath = `/tmp/cc-fingerprint-${version}.json`;
const safeOutPath = explicitOutPath || fallbackOutPath;
writeFileSync(safeOutPath, json, "utf8");

console.log(json);
console.error(`Saved: ${safeOutPath}`);
