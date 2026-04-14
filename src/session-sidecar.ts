import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { parseRequestBodyMetadata } from "./request/metadata.js";

const SESSION_USER_AGENT = "axios/1.13.6";
const SESSION_BETA = "ccr-byoc-2025-07-29";

type SessionRepoContext = {
    remoteUrl: string;
    branch: string;
};

export type SessionSidecarState = {
    codeSessionId?: string;
    createPromise?: Promise<void>;
    patchPromise?: Promise<void>;
    lastPatchedTitle?: string;
    organizationUuid?: string;
};

let cachedRepoContext: SessionRepoContext | null | undefined;

const TITLE_ADJECTIVES = [
    "amber",
    "brisk",
    "calm",
    "dapper",
    "fuzzy",
    "gentle",
    "goofy",
    "lucky",
    "mellow",
    "rosy",
    "silver",
    "tidy",
];

const TITLE_NOUNS = [
    "albatross",
    "badger",
    "falcon",
    "mccarthy",
    "otter",
    "panda",
    "quokka",
    "sparrow",
    "tapir",
    "walrus",
    "yak",
    "zephyr",
];

function normalizeSlug(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}

function maybeExecGit(args: string[]): string | null {
    try {
        const output = execFileSync("git", args, {
            cwd: process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return output || null;
    } catch {
        return null;
    }
}

function getRepoContext(): SessionRepoContext | null {
    if (cachedRepoContext !== undefined) {
        return cachedRepoContext;
    }

    const remoteUrl = maybeExecGit(["remote", "get-url", "origin"]);
    const branch = maybeExecGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    cachedRepoContext = remoteUrl && branch ? { remoteUrl, branch } : null;
    return cachedRepoContext;
}

function pickDeterministicWord(words: string[], key: string, salt: string): string {
    const hash = createHash("sha256").update(`${salt}:${key}`).digest();
    return words[hash[0] % words.length] ?? words[0] ?? "session";
}

function normalizeGitHubRepo(remoteUrl: string): string {
    return remoteUrl
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/^git@github\.com:/, "")
        .replace(/\.git$/, "");
}

export function buildCodeSessionTitle(signatureSessionId = "fallback-session"): string {
    const hostPart = normalizeSlug(hostname());
    const adjective = pickDeterministicWord(TITLE_ADJECTIVES, signatureSessionId, "adjective");
    const noun = pickDeterministicWord(TITLE_NOUNS, signatureSessionId, "noun");
    return [hostPart, adjective, noun].filter(Boolean).join("-") || "claude-code-session";
}

export function resetSessionSidecarCacheForTests(): void {
    cachedRepoContext = undefined;
}

export function extractOrganizationUuidFromBody(_body: string | undefined): string | undefined {
    return process.env.CLAUDE_CODE_ORGANIZATION_UUID?.trim() || undefined;
}

export function extractOrganizationUuidFromResponse(response: Response): string | undefined {
    return response.headers.get("anthropic-organization-id")?.trim() || undefined;
}

export function extractSessionTitleFromBody(body: string | undefined): string | undefined {
    if (!body) return undefined;

    try {
        const parsed = JSON.parse(body) as {
            messages?: Array<{
                role?: unknown;
                content?: unknown;
            }>;
        };

        const firstUserMessage = parsed.messages?.find((message) => message?.role === "user");
        if (!firstUserMessage) return undefined;

        if (typeof firstUserMessage.content === "string") {
            const normalized = firstUserMessage.content.replace(/\s+/g, " ").trim();
            return normalized || undefined;
        }

        if (Array.isArray(firstUserMessage.content)) {
            for (const block of firstUserMessage.content) {
                if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
                    const normalized = block.text.replace(/\s+/g, " ").trim();
                    if (normalized) return normalized;
                }
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

export function buildCodeSessionPayload(
    body: string | undefined,
    signatureSessionId?: string,
): Record<string, unknown> {
    const metadata = parseRequestBodyMetadata(body);
    const repoContext = getRepoContext();

    const config: Record<string, unknown> = {
        cwd: process.cwd(),
        ...(metadata.model ? { model: metadata.model } : {}),
    };

    if (repoContext) {
        config.sources = [
            {
                type: "git_repository",
                url: repoContext.remoteUrl,
                revision: repoContext.branch,
            },
        ];
        config.outcomes = [
            {
                type: "git_repository",
                git_info: {
                    type: repoContext.remoteUrl.includes("github.com") ? "github" : "git",
                    repo: normalizeGitHubRepo(repoContext.remoteUrl),
                    branches: [repoContext.branch],
                },
            },
        ];
        config.reuse_outcome_branches = true;
    }

    return {
        title: buildCodeSessionTitle(signatureSessionId),
        bridge: {},
        config,
    };
}

export function buildSessionSidecarHeaders(
    accessToken: string,
    organizationUuid?: string,
    includeByocBeta = false,
): Headers {
    const headers = new Headers({
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "User-Agent": SESSION_USER_AGENT,
        Connection: "close",
    });

    if (includeByocBeta) {
        headers.set("anthropic-beta", SESSION_BETA);
    }
    if (organizationUuid) {
        headers.set("x-organization-uuid", organizationUuid);
    }

    return headers;
}
