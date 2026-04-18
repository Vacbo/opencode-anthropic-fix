// Characterization tests for src/cli/status-api.ts.
//
// Pins the OAuth usage/profile endpoint constants and the internal error
// extraction shape before any CLI/status refactors. extractErrorMessage is
// private, so we exercise it through fetchUsage/fetchProfile which route
// every error response through the helper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CLAUDE_CLI_BOOTSTRAP_ENDPOINT,
    OAUTH_ACCOUNT_SETTINGS_ENDPOINT,
    OAUTH_CLAUDE_CLI_ROLES_ENDPOINT,
    OAUTH_PROFILE_ENDPOINT,
    OAUTH_USAGE_ENDPOINT,
    buildOAuthStatusHeaders,
    fetchProfile,
    fetchUsage,
} from "../../../src/cli/status-api.js";

describe("status-api endpoint constants", () => {
    it("pins every oauth status endpoint URL", () => {
        expect(OAUTH_USAGE_ENDPOINT).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(OAUTH_PROFILE_ENDPOINT).toBe("https://api.anthropic.com/api/oauth/profile");
        expect(OAUTH_ACCOUNT_SETTINGS_ENDPOINT).toBe("https://api.anthropic.com/api/oauth/account/settings");
        expect(OAUTH_CLAUDE_CLI_ROLES_ENDPOINT).toBe("https://api.anthropic.com/api/oauth/claude_cli/roles");
        expect(CLAUDE_CLI_BOOTSTRAP_ENDPOINT).toBe("https://api.anthropic.com/api/claude_cli/bootstrap");
    });
});

describe("buildOAuthStatusHeaders", () => {
    it("returns OAuth bearer headers with authorization when given a token", () => {
        const headers = buildOAuthStatusHeaders("token-abc");
        expect(headers.authorization).toBe("Bearer token-abc");
    });
});

describe("fetchUsage / fetchProfile error extraction", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        global.fetch = Object.assign(fetchSpy, {
            preconnect: vi.fn(),
        }) as typeof fetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function mockResponse(status: number, body: string, ok = status >= 200 && status < 300): Response {
        return {
            ok,
            status,
            text: () => Promise.resolve(body),
        } as unknown as Response;
    }

    it("returns the nested error.message verbatim on error responses", async () => {
        fetchSpy.mockResolvedValueOnce(
            mockResponse(403, JSON.stringify({ error: { message: "forbidden by policy" } })),
        );
        const result = await fetchUsage("token-a");
        expect(result.data).toBeNull();
        expect(result.error).toBe("forbidden by policy");
    });

    it("falls back to the HTTP status when error.message is missing", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(500, JSON.stringify({ error: {} })));
        const result = await fetchUsage("token-a");
        expect(result.error).toBe("HTTP 500");
    });

    it("falls back to the HTTP status when error.message is an empty string", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(400, JSON.stringify({ error: { message: "" } })));
        const result = await fetchUsage("token-a");
        expect(result.error).toBe("HTTP 400");
    });

    it("falls back to the HTTP status when the response body is not JSON", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(502, "<html>bad gateway</html>"));
        const result = await fetchUsage("token-a");
        expect(result.error).toBe("HTTP 502");
    });

    it("returns 'request failed' when fetch itself throws", async () => {
        fetchSpy.mockRejectedValueOnce(new Error("network down"));
        const result = await fetchUsage("token-a");
        expect(result.error).toBe("request failed");
        expect(result.data).toBeNull();
    });

    it("returns parsed JSON on success with no error", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(200, JSON.stringify({ five_hour: { utilization: 0.25 } })));
        const result = await fetchUsage("token-a");
        expect(result.error).toBeNull();
        expect(result.data).toEqual({ five_hour: { utilization: 0.25 } });
    });

    it("fetchProfile applies the same error-extraction contract and includes axios user-agent", async () => {
        fetchSpy.mockResolvedValueOnce(mockResponse(401, JSON.stringify({ error: { message: "expired" } })));
        const result = await fetchProfile("token-a");
        expect(result.error).toBe("expired");

        const [, init] = fetchSpy.mock.calls[0];
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers["user-agent"]).toBe("axios/1.13.6");
        expect(headers.accept).toBe("application/json, text/plain, */*");
    });
});
