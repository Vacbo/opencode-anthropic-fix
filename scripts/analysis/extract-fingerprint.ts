#!/usr/bin/env bun
/**
 * extract-fingerprint.ts — Consolidated extraction of CC bundle fingerprints
 * Combines oauth, headers, betas, and billing extraction into one script.
 *
 * Usage: bun scripts/analysis/extract-fingerprint.ts <cli.js-path> --version <ver> [--json] [--markdown]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createProgress } from "../lib/progress.ts";
import type {
    BetasFingerprint,
    BillingFingerprint,
    Fingerprint,
    HeadersFingerprint,
    OAuthFingerprint,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// OAuth patterns
const clientIdRe = /CLIENT_ID[^"]*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;
const scopeArrayRe = /"(user:[a-z_]+|org:[a-z_]+)"/g;
const endpointPatterns: Record<string, RegExp> = {
    platformBase: /["'](https:\/\/platform\.claude\.com[^"']*)["']/g,
    claudeAi: /["'](https:\/\/claude\.ai[^"']*)["']/g,
    tokenEndpoint: /["'](\/v1\/oauth\/token)["']/g,
    authorizeEndpoint: /["'](\/oauth\/authorize)["']/g,
};

// Headers patterns
const uaRe = /["'`](claude-cli\/[^"'`]*)["'`]/g;
const versionLiteralRe = /VERSION:"(\d+\.\d+\.\d+)"/;
const sdkVersionRe = /\beo="(0\.[0-9]+\.[0-9]+)"/;
const sdkVersionGeneralRe = /"(0\.\d+\.\d+)"/g;
const axiosVersionRe = /["'`]axios\/([0-9]+\.[0-9]+\.[0-9]+)/;
const stainlessRe = /["'](x-stainless-[a-z0-9-]+)["']/g;

// Betas patterns
const betaRe = /"([a-z][a-z0-9-]*-[0-9]{4}-[0-9]{2}-[0-9]{2})"/g;
const bedrockCtxRe = /bedrock[^;]{0,500}new Set\(\[([^\]]+)\]\)/g;
const bedrockCtxRevRe = /new Set\(\[([^\]]{0,800})\]\)[^;]{0,200}bedrock/g;
const oauthBetaRe = /"(oauth-[0-9]{4}-[0-9]{2}-[0-9]{2})"/g;

// Billing patterns
const cchRe = /[" ](cch=[0-9a-f]+)[";]/g;
const hexSaltRe = /"([0-9a-f]{64})"/g;
const hashPosRe = /\.slice\(([0-9]+),\s*([0-9]+)\)/g;
const quotedLiteralRe = /["'`]([^"'`\r\n]{1,160})["'`]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Note: These helpers reset lastIndex to allow safe reuse of global regexes.
// All regex patterns are hardcoded constants above — no user input involved.
function collectMatches(source: string, re: RegExp, group = 1): string[] {
    const results: string[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    m = re.exec(source);
    while (m !== null) {
        if (m[group] && !results.includes(m[group])) {
            results.push(m[group]);
        }
        m = re.exec(source);
    }
    re.lastIndex = 0;
    return results;
}

function firstMatch(source: string, re: RegExp, group = 1): string | null {
    re.lastIndex = 0;
    const m = re.exec(source);
    re.lastIndex = 0;
    return m ? (m[group] ?? null) : null;
}

function extractBunCompiledUserAgentTemplate(source: string): string | null {
    const idx = source.indexOf("claude-cli/${");
    if (idx === -1) {
        return null;
    }

    const version = firstMatch(source, versionLiteralRe);
    if (!version) {
        return null;
    }

    const window = source.substring(idx, idx + 500);
    if (!window.includes("external")) {
        return null;
    }

    const entrypoint =
        window.includes("sdk-cli") || window.includes('CLAUDE_CODE_ENTRYPOINT??"cli"') ? "sdk-cli" : "cli";
    return `claude-cli/${version} (external, ${entrypoint})`;
}

function extractBunCompiledBillingTemplate(source: string): string | null {
    const idx = source.indexOf("x-anthropic-billing-header:");
    if (idx === -1) {
        return null;
    }

    const start = source.lastIndexOf("`", idx);
    const end = source.indexOf("`", idx);
    if (start === -1 || end === -1 || end <= start) {
        return null;
    }

    return source.slice(start + 1, end);
}

function collectQuotedLiterals(source: string): string[] {
    return collectMatches(source, quotedLiteralRe);
}

function isCodeLikeFragment(value: string): boolean {
    return value.includes("${") || /\b(function|return|class|const|let|var|if)\b/.test(value) || /[{};$]/.test(value);
}

function isPlausibleUserAgentTemplate(value: string): boolean {
    if (!value.startsWith("claude-cli/")) {
        return false;
    }

    if (!/claude-cli\/\d+\.\d+\.\d+/.test(value)) {
        return false;
    }

    if (value.length > 120 || /[\r\n]/.test(value) || isCodeLikeFragment(value)) {
        return false;
    }

    return true;
}

function scoreUserAgentTemplate(value: string): number {
    let score = 0;
    if (value.includes("(external")) {
        score += 3;
    }
    if (value.includes("sdk-cli") || value.includes("cli")) {
        score += 2;
    }
    if (!/[${}]/.test(value)) {
        score += 1;
    }
    return score;
}

function isPlausibleHeaderLiteral(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 120) {
        return false;
    }

    if (trimmed.length === 1 && /[A-Za-z]/.test(trimmed)) {
        return false;
    }

    if (isCodeLikeFragment(trimmed) || /[<>\r\n]/.test(trimmed)) {
        return false;
    }

    if (/^x-[a-z0-9-]+$/.test(trimmed)) {
        return false;
    }

    return /^[A-Za-z0-9][A-Za-z0-9._,/ :-]*$/.test(trimmed);
}

function findNearestLiteralAfter(
    source: string,
    anchor: string,
    predicate: (value: string) => boolean,
    maxWindow = 300,
    stopPattern?: RegExp,
): string | null {
    let searchStart = 0;

    while (true) {
        const idx = source.indexOf(anchor, searchStart);
        if (idx === -1) {
            return null;
        }

        const rawWindow = source.substring(idx + anchor.length, idx + anchor.length + maxWindow);
        const stopIndex = stopPattern ? rawWindow.search(stopPattern) : -1;
        const window = stopIndex >= 0 ? rawWindow.substring(0, stopIndex) : rawWindow;
        const candidates = collectQuotedLiterals(window).filter((value) => value !== anchor);
        const match = candidates.find(predicate);
        if (match) {
            return match;
        }

        searchStart = idx + anchor.length;
    }
}

// ---------------------------------------------------------------------------
// Extraction functions (exported for reuse by npm-watcher.ts)
// ---------------------------------------------------------------------------

export function extractOAuth(source: string): OAuthFingerprint {
    const clientIds = collectMatches(source, clientIdRe);
    const scopes = collectMatches(source, scopeArrayRe);

    const endpoints: Record<string, string | string[]> = {};
    for (const [key, pattern] of Object.entries(endpointPatterns)) {
        const matches = collectMatches(source, pattern);
        endpoints[key] = matches.length === 1 ? matches[0] : matches;
    }

    // PKCE detection
    const hasCodeChallenge = /code_challenge/.test(source);
    const hasCodeVerifier = /code_verifier/.test(source);
    const s256Confirmed = /S256/.test(source);
    const methodMatch = /code_challenge_method/.test(source);

    return {
        clientIds,
        scopes,
        endpoints,
        pkce: {
            hasCodeChallenge,
            hasCodeVerifier,
            method: methodMatch ? "S256" : null,
            s256Confirmed,
        },
    };
}

export function extractHeaders(source: string): HeadersFingerprint {
    // User-Agent
    const uaMatches = collectMatches(source, uaRe);
    const uaTemplate =
        uaMatches
            .filter(isPlausibleUserAgentTemplate)
            .sort((left, right) => scoreUserAgentTemplate(right) - scoreUserAgentTemplate(left))[0] ??
        extractBunCompiledUserAgentTemplate(source);
    const hasExternal = uaMatches.length > 0 || (uaTemplate?.includes("(external") ?? false);

    // SDK version — try specific pattern first, then general near "anthropic"
    let sdkVersion = firstMatch(source, sdkVersionRe);
    if (!sdkVersion) {
        const generalPattern = new RegExp(sdkVersionGeneralRe.source, sdkVersionGeneralRe.flags);
        let m: RegExpExecArray | null;
        m = generalPattern.exec(source);
        while (m !== null) {
            const idx = m.index;
            const context = source.substring(Math.max(0, idx - 200), idx + 200);
            if (/anthropic/i.test(context)) {
                sdkVersion = m[1];
                break;
            }
            m = generalPattern.exec(source);
        }
    }

    // Axios version
    const axiosVersion = firstMatch(source, axiosVersionRe);

    // Stainless headers — find values by searching near the header name
    const stainlessKeys = collectMatches(source, stainlessRe);
    const stainlessHeaders: Record<string, string | null> = {};
    for (const key of stainlessKeys) {
        stainlessHeaders[key] = findNearestLiteralAfter(source, key, isPlausibleHeaderLiteral, 300, /["']x-stainless-/);
    }

    return {
        userAgent: {
            template: uaTemplate,
            hasExternal,
        },
        sdkVersion,
        axiosVersion,
        stainlessHeaders,
    };
}

export function extractBetas(source: string): BetasFingerprint {
    const betas = collectMatches(source, betaRe);

    // Bedrock unsupported betas
    const bedrockUnsupported: string[] = [];
    const bedrockPatterns = [bedrockCtxRe, bedrockCtxRevRe];
    for (const pattern of bedrockPatterns) {
        const setContents = collectMatches(source, pattern);
        for (const content of setContents) {
            const innerBetas = collectMatches(content, /"([^"]+)"/g);
            for (const b of innerBetas) {
                if (!bedrockUnsupported.includes(b)) {
                    bedrockUnsupported.push(b);
                }
            }
        }
    }

    // OAuth-specific betas
    const oauthBetas = collectMatches(source, oauthBetaRe);
    const oauthBeta = oauthBetas[0] ?? null;

    return {
        betas,
        bedrockUnsupported,
        oauthBeta,
        oauthBetas,
    };
}

export function extractBilling(source: string): BillingFingerprint {
    const allCchValues = collectMatches(source, cchRe);
    const cch = allCchValues[0] ?? null;

    const allSalts = collectMatches(source, hexSaltRe);
    const salt = allSalts[0] ?? null;

    // Hash positions (slice patterns)
    const hashPositions: Array<{ start: number; end: number }> = [];
    const posPattern = new RegExp(hashPosRe.source, hashPosRe.flags);
    let m: RegExpExecArray | null;
    m = posPattern.exec(source);
    while (m !== null) {
        const start = parseInt(m[1], 10);
        const end = parseInt(m[2], 10);
        const found = hashPositions.find((p) => p.start === start && p.end === end);
        if (!found) {
            hashPositions.push({ start, end });
        }
        m = posPattern.exec(source);
    }

    // Try to reconstruct a billing template pattern
    const allTemplates: string[] = [];
    const templateRe = /`(cch=\$\{[^`]+\})`/g;
    const templates = collectMatches(source, templateRe);
    allTemplates.push(...templates);

    if (allTemplates.length === 0) {
        const bunTemplate = extractBunCompiledBillingTemplate(source);
        if (bunTemplate) {
            allTemplates.push(bunTemplate);
        }
    }

    return {
        cch,
        allCchValues,
        salt,
        allSalts,
        template: allTemplates[0] ?? null,
        allTemplates,
        hashPositions,
    };
}

export function extractFingerprint(source: string, version: string): Fingerprint {
    return {
        version,
        extractedAt: new Date().toISOString(),
        oauth: extractOAuth(source),
        headers: extractHeaders(source),
        betas: extractBetas(source),
        billing: extractBilling(source),
    };
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function toMarkdown(fp: Fingerprint): string {
    const lines: string[] = [];
    const ln = (s = "") => lines.push(s);

    ln(`# Claude Code ${fp.version} Fingerprint`);
    ln();
    ln(`Extracted at: ${fp.extractedAt}`);
    ln();

    // OAuth
    ln(`## OAuth`);
    ln();
    ln(`### Client IDs`);
    for (const id of fp.oauth.clientIds) ln(`- \`${id}\``);
    if (fp.oauth.clientIds.length === 0) ln("_none found_");
    ln();
    ln(`### Scopes`);
    for (const s of fp.oauth.scopes) ln(`- \`${s}\``);
    if (fp.oauth.scopes.length === 0) ln("_none found_");
    ln();
    ln(`### Endpoints`);
    for (const [key, val] of Object.entries(fp.oauth.endpoints)) {
        const display = Array.isArray(val) ? val.map((v) => `\`${v}\``).join(", ") : `\`${val}\``;
        ln(`- **${key}**: ${display}`);
    }
    ln();
    ln(`### PKCE`);
    ln(`- code_challenge: ${fp.oauth.pkce.hasCodeChallenge}`);
    ln(`- code_verifier: ${fp.oauth.pkce.hasCodeVerifier}`);
    ln(`- method: ${fp.oauth.pkce.method ?? "unknown"}`);
    ln(`- S256 confirmed: ${fp.oauth.pkce.s256Confirmed}`);
    ln();

    // Headers
    ln(`## Headers`);
    ln();
    ln(`- User-Agent template: \`${fp.headers.userAgent.template ?? "N/A"}\``);
    ln(`- SDK version: \`${fp.headers.sdkVersion ?? "N/A"}\``);
    ln(`- Axios version: \`${fp.headers.axiosVersion ?? "N/A"}\``);
    ln();
    ln(`### Stainless Headers`);
    for (const [key, val] of Object.entries(fp.headers.stainlessHeaders)) {
        ln(`- \`${key}\`: ${val ? `\`${val}\`` : "_value not resolved_"}`);
    }
    if (Object.keys(fp.headers.stainlessHeaders).length === 0) ln("_none found_");
    ln();

    // Betas
    ln(`## Betas`);
    ln();
    ln(`### All Beta Flags`);
    for (const b of fp.betas.betas) ln(`- \`${b}\``);
    if (fp.betas.betas.length === 0) ln("_none found_");
    ln();
    ln(`### Bedrock Unsupported`);
    for (const b of fp.betas.bedrockUnsupported) ln(`- \`${b}\``);
    if (fp.betas.bedrockUnsupported.length === 0) ln("_none found_");
    ln();
    ln(`### OAuth Beta`);
    ln(`- Primary: \`${fp.betas.oauthBeta ?? "N/A"}\``);
    if (fp.betas.oauthBetas.length > 1) {
        ln(`- All: ${fp.betas.oauthBetas.map((b) => `\`${b}\``).join(", ")}`);
    }
    ln();

    // Billing
    ln(`## Billing`);
    ln();
    ln(`- CCH: \`${fp.billing.cch ?? "N/A"}\``);
    ln(`- Salt: \`${fp.billing.salt ? fp.billing.salt.substring(0, 16) + "..." : "N/A"}\``);
    ln(`- Template: \`${fp.billing.template ?? "N/A"}\``);
    ln();
    ln(`### Hash Positions`);
    for (const pos of fp.billing.hashPositions) {
        ln(`- \`.slice(${pos.start}, ${pos.end})\``);
    }
    if (fp.billing.hashPositions.length === 0) ln("_none found_");
    ln();

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): {
    cliJsPath: string;
    version: string;
    json: boolean;
    markdown: boolean;
} {
    let cliJsPath = "";
    let version = "";
    let json = false;
    let markdown = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--version" && i + 1 < args.length) {
            version = args[++i];
        } else if (arg === "--json") {
            json = true;
        } else if (arg === "--markdown") {
            markdown = true;
        } else if (!arg.startsWith("--")) {
            cliJsPath = arg;
        }
    }

    if (!cliJsPath) {
        console.error(
            "Usage: bun scripts/analysis/extract-fingerprint.ts <cli.js-path> --version <ver> [--json] [--markdown]",
        );
        process.exit(1);
    }

    if (!version) {
        // Try to infer version from filename (e.g., cli-1.0.20.js)
        const match = cliJsPath.match(/cli-([0-9]+\.[0-9]+\.[0-9]+)\.js/);
        version = match ? match[1] : "unknown";
    }

    // Default to JSON if neither flag is set
    if (!json && !markdown) {
        json = true;
    }

    return { cliJsPath: resolve(cliJsPath), version, json, markdown };
}

async function main() {
    const args = process.argv.slice(2);
    const { cliJsPath, version, json, markdown } = parseArgs(args);
    const progress = createProgress();

    progress.startStep("read bundle", cliJsPath);
    const source = readFileSync(cliJsPath, "utf-8");
    const mb = (source.length / 1024 / 1024).toFixed(1);
    progress.finishStep(`${mb}MB`);

    progress.startStep("extract fingerprint", version);
    const fingerprint = extractFingerprint(source, version);
    progress.finishStep();

    if (json) {
        console.log(JSON.stringify(fingerprint, null, 2));
    }

    if (markdown) {
        progress.startStep("write markdown report");
        const md = toMarkdown(fingerprint);
        const docsDir = resolve(process.cwd(), "docs/cc-versions");
        mkdirSync(docsDir, { recursive: true });
        const mdPath = resolve(docsDir, `${version}.md`);
        writeFileSync(mdPath, md, "utf-8");
        progress.finishStep(mdPath);
    }

    progress.done();
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    });
}
