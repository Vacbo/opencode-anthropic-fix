import { buildOAuthBearerHeaders } from "../headers/oauth-bearer.js";

export const OAUTH_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const OAUTH_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
export const OAUTH_ACCOUNT_SETTINGS_ENDPOINT = "https://api.anthropic.com/api/oauth/account/settings";
export const OAUTH_CLAUDE_CLI_ROLES_ENDPOINT = "https://api.anthropic.com/api/oauth/claude_cli/roles";
export const CLAUDE_CLI_BOOTSTRAP_ENDPOINT = "https://api.anthropic.com/api/claude_cli/bootstrap";

export type StatusApiResult<T> = {
    data: T | null;
    error: string | null;
};

type ErrorShape = {
    error?: {
        message?: string;
    };
};

export type OAuthProfilePayload = {
    account?: {
        uuid?: string;
        email?: string;
        email_address?: string;
        display_name?: string;
        full_name?: string;
    };
    organization?: {
        uuid?: string;
        name?: string;
    };
    application?: {
        name?: string;
        slug?: string;
    };
};

function extractErrorMessage(parsedBody: ErrorShape | null, status: number): string {
    const message = parsedBody?.error?.message;
    return typeof message === "string" && message.length > 0 ? message : `HTTP ${status}`;
}

async function fetchStatusJson<T>(
    endpoint: string,
    headers: Record<string, string>,
    timeoutMs = 5000,
): Promise<StatusApiResult<T>> {
    try {
        const resp = await fetch(endpoint, {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
        });

        const responseText = await resp.text();
        let parsedBody: T | null = null;
        try {
            parsedBody = JSON.parse(responseText) as T;
        } catch {
            parsedBody = null;
        }

        if (!resp.ok) {
            return {
                data: null,
                error: extractErrorMessage(parsedBody as ErrorShape | null, resp.status),
            };
        }

        return {
            data: parsedBody,
            error: null,
        };
    } catch {
        return {
            data: null,
            error: "request failed",
        };
    }
}

export function buildOAuthStatusHeaders(accessToken: string, includeOauthBeta = true): Record<string, string> {
    return buildOAuthBearerHeaders(accessToken, { includeOauthBeta });
}

export async function fetchUsage(accessToken: string) {
    return fetchStatusJson<Record<string, unknown>>(OAUTH_USAGE_ENDPOINT, buildOAuthStatusHeaders(accessToken));
}

export async function fetchProfile(accessToken: string) {
    return fetchStatusJson<OAuthProfilePayload>(OAUTH_PROFILE_ENDPOINT, {
        ...buildOAuthStatusHeaders(accessToken, false),
        accept: "application/json, text/plain, */*",
        "user-agent": "axios/1.13.6",
    });
}
