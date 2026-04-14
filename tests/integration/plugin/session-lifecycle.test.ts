import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetchHarness } from "../../helpers/plugin-fetch-harness.js";

vi.mock("node:readline/promises", () => ({
    createInterface: vi.fn(() => ({
        question: vi.fn().mockResolvedValue("a"),
        close: vi.fn(),
    })),
}));

vi.mock("../../../src/storage.js", () => ({
    createDefaultStats: (now?: number) => ({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        lastReset: now ?? Date.now(),
    }),
    loadAccounts: vi.fn().mockResolvedValue(null),
    saveAccounts: vi.fn().mockResolvedValue(undefined),
    clearAccounts: vi.fn().mockResolvedValue(undefined),
    getStoragePath: vi.fn(() => "/tmp/test-accounts.json"),
}));

vi.mock("../../../src/config.js", () => {
    const DEFAULT_CONFIG = {
        account_selection_strategy: "sticky",
        failure_ttl_seconds: 3600,
        debug: false,
        signature_emulation: {
            enabled: true,
            fetch_claude_code_version_on_startup: false,
            prompt_compaction: "minimal",
        },
        override_model_limits: {
            enabled: false,
            context: 1_000_000,
            output: 0,
        },
        custom_betas: [],
        health_score: {
            initial: 70,
            success_reward: 1,
            rate_limit_penalty: -10,
            failure_penalty: -20,
            recovery_rate_per_hour: 2,
            min_usable: 50,
            max_score: 100,
        },
        token_bucket: {
            max_tokens: 50,
            regeneration_rate_per_minute: 6,
            initial_tokens: 50,
        },
        toasts: {
            quiet: true,
            debounce_seconds: 30,
        },
        headers: {},
        idle_refresh: {
            enabled: false,
            window_minutes: 60,
            min_interval_minutes: 30,
        },
        cc_credential_reuse: {
            enabled: false,
            auto_detect: false,
            prefer_over_oauth: false,
        },
    };

    const createBaseConfig = () => ({
        ...DEFAULT_CONFIG,
        account_selection_strategy: "sticky",
        signature_emulation: {
            ...DEFAULT_CONFIG.signature_emulation,
            fetch_claude_code_version_on_startup: false,
        },
        override_model_limits: {
            ...DEFAULT_CONFIG.override_model_limits,
        },
        custom_betas: [...DEFAULT_CONFIG.custom_betas],
        health_score: { ...DEFAULT_CONFIG.health_score },
        token_bucket: { ...DEFAULT_CONFIG.token_bucket },
        toasts: { ...DEFAULT_CONFIG.toasts },
        headers: { ...DEFAULT_CONFIG.headers },
        idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: false },
        cc_credential_reuse: { ...DEFAULT_CONFIG.cc_credential_reuse },
    });

    return {
        CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        DEFAULT_CONFIG,
        VALID_STRATEGIES: ["sticky", "round-robin", "hybrid"],
        loadConfig: vi.fn(() => createBaseConfig()),
        loadConfigFresh: vi.fn(() => createBaseConfig()),
        saveConfig: vi.fn(),
        getConfigDir: vi.fn(() => "/tmp/test-config"),
    };
});

vi.mock("../../../src/cc-credentials.js", () => ({
    readCCCredentials: vi.fn(() => []),
}));

vi.mock("../../../src/refresh-lock.js", () => ({
    acquireRefreshLock: vi.fn().mockResolvedValue({
        acquired: true,
        lockPath: "/tmp/opencode-test.lock",
        release: vi.fn().mockResolvedValue(undefined),
    }),
    releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

describe("Claude session lifecycle sidecar", () => {
    afterEach(() => {
        delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    });

    it("creates a code session after a successful /v1/messages request", async () => {
        process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "session_123";

        const harness = await createFetchHarness({
            mockResponses: {
                "/v1/messages": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({
                        id: "msg_123",
                        type: "message",
                        role: "assistant",
                        content: [],
                    }),
                }),
                "/v1/code/sessions": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ session: { id: "cse_123" } }),
                }),
            },
        });

        await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-opus-4-6",
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        await harness.waitFor(() => {
            expect(harness.mockFetch.mock.calls.some((call) => String(call[0]).includes("/v1/code/sessions"))).toBe(
                true,
            );
        });

        const createCall = harness.mockFetch.mock.calls.find((call) => String(call[0]).includes("/v1/code/sessions"));
        const [, init] = createCall ?? [];
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        const body = JSON.parse(String(init?.body));

        expect(headers.get("user-agent")).toBe("axios/1.13.6");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(body.bridge).toEqual({});
        expect(body.config.cwd).toBe(process.cwd());
        expect(body.config.model).toBe("claude-opus-4-6");
        expect(body.title).toMatch(/^[a-z0-9-]+-[a-z]+-[a-z]+$/);

        harness.tearDown();
    });

    it("patches the remote session title when CLAUDE_CODE_REMOTE_SESSION_ID is available", async () => {
        process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "session_456";
        process.env.CLAUDE_CODE_ORGANIZATION_UUID = "org-123";

        const harness = await createFetchHarness({
            mockResponses: {
                "/v1/messages": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({
                        id: "msg_123",
                        type: "message",
                        role: "assistant",
                        content: [],
                    }),
                }),
                "/v1/code/sessions": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ session: { id: "cse_123" } }),
                }),
                "/v1/sessions/session_456": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ id: "session_456" }),
                }),
            },
        });

        await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "hi" }],
            }),
        });

        await harness.waitFor(() => {
            expect(
                harness.mockFetch.mock.calls.some((call) => String(call[0]).includes("/v1/sessions/session_456")),
            ).toBe(true);
        });

        const patchCall = harness.mockFetch.mock.calls.find((call) =>
            String(call[0]).includes("/v1/sessions/session_456"),
        );
        const [, init] = patchCall ?? [];
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
        const body = JSON.parse(String(init?.body));

        expect(headers.get("user-agent")).toBe("axios/1.13.6");
        expect(headers.get("anthropic-beta")).toBe("ccr-byoc-2025-07-29");
        expect(headers.get("x-organization-uuid")).toBe("org-123");
        expect(body).toEqual({ title: "hi" });

        harness.tearDown();
    });

    it("creates a distinct local/remote session lifecycle per OpenCode chat session", async () => {
        process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "session_789";
        process.env.CLAUDE_CODE_ORGANIZATION_UUID = "org-789";

        const harness = await createFetchHarness({
            mockResponses: {
                "/v1/messages": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({
                        id: "msg_123",
                        type: "message",
                        role: "assistant",
                        content: [],
                    }),
                }),
                "/v1/code/sessions": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ session: { id: "cse_123" } }),
                }),
                "/v1/sessions/session_789": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ id: "session_789" }),
                }),
            },
        });

        const transform = harness.plugin["experimental.chat.system.transform"] as (
            input: Record<string, unknown>,
            output: Record<string, unknown>,
        ) => void;

        transform({ sessionID: "chat-1", model: { providerID: "anthropic" } }, { system: [] });
        await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "first chat" }],
            }),
        });

        transform({ sessionID: "chat-2", model: { providerID: "anthropic" } }, { system: [] });
        await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "second chat" }],
            }),
        });

        const messageCalls = harness.mockFetch.mock.calls.filter((call) => String(call[0]).includes("/v1/messages"));
        expect(messageCalls).toHaveLength(2);
        const firstHeaders = messageCalls[0]?.[1]?.headers as Headers;
        const secondHeaders = messageCalls[1]?.[1]?.headers as Headers;
        expect(firstHeaders.get("x-claude-code-session-id")).toBeTruthy();
        expect(secondHeaders.get("x-claude-code-session-id")).toBeTruthy();
        expect(firstHeaders.get("x-claude-code-session-id")).not.toBe(secondHeaders.get("x-claude-code-session-id"));

        const codeSessionCalls = harness.mockFetch.mock.calls.filter((call) =>
            String(call[0]).includes("/v1/code/sessions"),
        );
        expect(codeSessionCalls).toHaveLength(2);

        harness.tearDown();
    });

    it("integrates message flow with code-session creation and remote session title sync", async () => {
        process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "session_999";
        process.env.CLAUDE_CODE_ORGANIZATION_UUID = "org-999";

        const harness = await createFetchHarness({
            mockResponses: {
                "/v1/messages": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({
                        id: "msg_123",
                        type: "message",
                        role: "assistant",
                        content: [],
                    }),
                }),
                "/v1/code/sessions": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ session: { id: "cse_999" } }),
                }),
                "/v1/sessions/session_999": () => ({
                    status: 200,
                    headers: new Headers({ "content-type": "application/json" }),
                    json: async () => ({ id: "session_999" }),
                }),
            },
        });

        const transform = harness.plugin["experimental.chat.system.transform"] as (
            input: Record<string, unknown>,
            output: Record<string, unknown>,
        ) => void;
        transform({ sessionID: "chat-int", model: { providerID: "anthropic" } }, { system: [] });

        await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-opus-4-6[1m]",
                messages: [{ role: "user", content: "integration hello" }],
            }),
        });

        await harness.waitFor(() => {
            const urls = harness.mockFetch.mock.calls.map((call) => String(call[0]));
            expect(urls.some((url) => url.includes("/v1/messages"))).toBe(true);
            expect(urls.some((url) => url.includes("/v1/code/sessions"))).toBe(true);
            expect(urls.some((url) => url.includes("/v1/sessions/session_999"))).toBe(true);
        });

        const messageCall = harness.mockFetch.mock.calls.find((call) => String(call[0]).includes("/v1/messages"));
        const createCall = harness.mockFetch.mock.calls.find((call) => String(call[0]).includes("/v1/code/sessions"));
        const patchCall = harness.mockFetch.mock.calls.find((call) =>
            String(call[0]).includes("/v1/sessions/session_999"),
        );

        const messageHeaders = messageCall?.[1]?.headers as Headers;
        const createHeaders = createCall?.[1]?.headers as Headers;
        const patchHeaders = patchCall?.[1]?.headers as Headers;

        const messageBody = JSON.parse(String(messageCall?.[1]?.body));
        const createBody = JSON.parse(String(createCall?.[1]?.body));
        const patchBody = JSON.parse(String(patchCall?.[1]?.body));

        expect(messageHeaders.get("x-claude-code-session-id")).toBeTruthy();
        expect(messageBody.metadata.user_id).toContain(messageHeaders.get("x-claude-code-session-id") ?? "");
        expect(messageBody.metadata.organization_uuid).toBeUndefined();

        expect(createHeaders.get("user-agent")).toBe("axios/1.13.6");
        expect(createBody.bridge).toEqual({});
        expect(createBody.config.cwd).toBe(process.cwd());
        expect(createBody.config.model).toBe("claude-opus-4-6[1m]");

        expect(patchHeaders.get("anthropic-beta")).toBe("ccr-byoc-2025-07-29");
        expect(patchHeaders.get("x-organization-uuid")).toBe("org-999");
        expect(patchBody).toEqual({ title: "integration hello" });

        harness.tearDown();
    });

    it("routes message and session sidecar requests through the Bun forwarder in the live path", async () => {
        process.env.CLAUDE_CODE_REMOTE_SESSION_ID = "session_forward";
        process.env.CLAUDE_CODE_ORGANIZATION_UUID = "org-forward";

        const harness = await createFetchHarness();
        const bunFetch = vi.fn(async (input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

            if (url.includes("/v1/messages")) {
                return new Response(
                    JSON.stringify({
                        id: "msg_forward",
                        type: "message",
                        role: "assistant",
                        content: [],
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                );
            }

            if (url.includes("/v1/code/sessions")) {
                return new Response(JSON.stringify({ session: { id: "cse_forward" } }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }

            if (url.includes("/v1/sessions/session_forward")) {
                return new Response(JSON.stringify({ id: "session_forward" }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }

            return new Response("not found", { status: 404 });
        });
        const nativeFetchShouldNotRun = (async (_input: string | URL | Request, _init?: RequestInit) => {
            throw new Error("native fetch should not be used");
        }) as unknown as typeof fetch;

        vi.stubGlobal("Bun", { fetch: bunFetch });
        globalThis.fetch = nativeFetchShouldNotRun;

        await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                messages: [{ role: "user", content: "forward this" }],
            }),
        });

        await harness.waitFor(() => {
            const urls = bunFetch.mock.calls.map(([input]) =>
                typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
            );

            expect(urls.some((url) => url.includes("/v1/messages"))).toBe(true);
            expect(urls.some((url) => url.includes("/v1/code/sessions"))).toBe(true);
            expect(urls.some((url) => url.includes("/v1/sessions/session_forward"))).toBe(true);
        });

        expect(harness.mockFetch).not.toHaveBeenCalled();

        harness.tearDown();
    });
});
