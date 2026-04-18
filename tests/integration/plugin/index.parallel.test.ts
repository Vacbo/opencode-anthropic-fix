import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createDeferred, createDeferredQueue, nextTick } from "../../helpers/deferred.js";
import { clearMockAccounts, createFetchHarness } from "../../helpers/plugin-fetch-harness.js";
import { toWireToolName } from "../../../src/tools/wire-names.js";
import {
    contentBlockStartEvent,
    contentBlockStopEvent,
    encodeSSEStream,
    makeSSEResponse,
    messageDeltaEvent,
    messageStartEvent,
    messageStopEvent,
} from "../../helpers/sse.js";

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
        relocate_third_party_prompts: true,
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
        signature_emulation: { ...DEFAULT_CONFIG.signature_emulation },
        override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
        custom_betas: [...DEFAULT_CONFIG.custom_betas],
        health_score: { ...DEFAULT_CONFIG.health_score },
        token_bucket: { ...DEFAULT_CONFIG.token_bucket },
        toasts: { ...DEFAULT_CONFIG.toasts },
        headers: { ...DEFAULT_CONFIG.headers },
        idle_refresh: { ...DEFAULT_CONFIG.idle_refresh },
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
    readCCCredentialsFromFile: vi.fn(() => []),
}));

vi.mock("../../../src/refresh-lock.js", () => ({
    acquireRefreshLock: vi.fn().mockResolvedValue({
        acquired: true,
        lockPath: "/tmp/opencode-test.lock",
        owner: null,
        lockInode: null,
    }),
    releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/oauth.js", () => ({
    authorize: vi.fn(),
    exchange: vi.fn(),
    refreshToken: vi.fn(),
}));

vi.mock("@clack/prompts", () => {
    const noop = vi.fn();
    return {
        text: vi.fn().mockResolvedValue(""),
        confirm: vi.fn().mockResolvedValue(false),
        select: vi.fn().mockResolvedValue("cancel"),
        spinner: vi.fn(() => ({ start: noop, stop: noop, message: noop })),
        intro: noop,
        outro: noop,
        isCancel: vi.fn().mockReturnValue(false),
        log: {
            info: noop,
            success: noop,
            warn: noop,
            error: noop,
            message: noop,
            step: noop,
        },
        note: noop,
        cancel: noop,
    };
});

import { refreshToken } from "../../../src/oauth.js";

const mockRefreshToken = refreshToken as Mock;

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(payload), {
        status: init.status ?? 200,
        headers: {
            "content-type": "application/json",
            ...(init.headers as Record<string, string> | undefined),
        },
    });
}

function rateLimitResponse(message = "rate limit exceeded"): Response {
    return jsonResponse(
        {
            error: {
                type: "rate_limit_error",
                message,
            },
        },
        { status: 429 },
    );
}

function makeRequestBody(
    options: {
        toolName?: string;
        historicalToolName?: string;
        text?: string;
    } = {},
): string {
    const messages: Array<Record<string, unknown>> = [];

    if (options.historicalToolName) {
        messages.push({
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: `tool_${options.historicalToolName}`,
                    name: options.historicalToolName,
                    input: { from: options.text ?? "history" },
                },
            ],
        });
        messages.push({
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: `tool_${options.historicalToolName}`,
                    content: "ok",
                },
            ],
        });
    }

    messages.push({
        role: "user",
        content: options.text ?? "parallel test",
    });

    return JSON.stringify({
        model: "claude-sonnet",
        max_tokens: 128,
        messages,
        ...(options.toolName
            ? {
                  tools: [
                      {
                          name: options.toolName,
                          description: "Parallel test tool",
                          input_schema: {
                              type: "object",
                              properties: {
                                  id: { type: "number" },
                              },
                          },
                      },
                  ],
              }
            : {}),
    });
}

type SentRequestBody = {
    tools: Array<{ name: string }>;
    messages: Array<{ role?: string; content: Array<{ name?: string }> | string }>;
};

function parseSentBody(call: unknown[]): SentRequestBody {
    const init = call[1] as RequestInit | undefined;
    if (typeof init?.body !== "string") {
        throw new Error(`Expected string body, received ${typeof init?.body}`);
    }
    return JSON.parse(init.body) as SentRequestBody;
}

function callHeaders(call: unknown[]): Headers {
    const init = call[1] as RequestInit | undefined;
    return new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
}

function callUrl(call: unknown[]): string {
    const input = call[0];
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return String(input);
}

function makeToolUseSseResponse(prefixedName: string): Response {
    return makeSSEResponse(
        encodeSSEStream([
            messageStartEvent(),
            contentBlockStartEvent(0, {
                content_block: {
                    type: "tool_use",
                    id: "tool_stream_1",
                    name: prefixedName,
                    input: { ok: true },
                },
            }),
            contentBlockStopEvent(0),
            messageDeltaEvent({
                delta: { stop_reason: "tool_use", stop_sequence: null },
                usage: { output_tokens: 1 },
            }),
            messageStopEvent(),
        ]),
    );
}

describe("index.parallel RED", () => {
    beforeEach(() => {
        clearMockAccounts();
        vi.clearAllMocks();
        mockRefreshToken.mockResolvedValue({
            access_token: "access-default-refresh",
            expires_in: 3600,
            refresh_token: "refresh-default-refresh",
        });
    });

    afterEach(() => {
        clearMockAccounts();
    });

    it("intercepts 50 concurrent requests without double-prefixing historical tool definitions", async () => {
        const harness = await createFetchHarness();
        const queue = createDeferredQueue<Response>();

        harness.mockFetch.mockImplementation(() => queue.enqueue().promise);

        const requests = Array.from({ length: 50 }, (_, index) =>
            harness.fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: makeRequestBody({
                    toolName: `mcp_parallel_tool_${index}`,
                    text: `fan-out-${index}`,
                }),
            }),
        );

        await harness.waitFor(() => expect(queue.pending).toBe(50), 1000);

        for (let index = 0; index < 50; index += 1) {
            queue.resolveNext(
                jsonResponse({
                    id: `msg_${index}`,
                    content: [{ type: "text", text: `ok-${index}` }],
                }),
            );
        }

        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.json()));

        const sentBodies = harness.mockFetch.mock.calls.map((call) => parseSentBody(call));
        sentBodies.forEach((body, index) => {
            expect(body.tools[0].name).toBe(toWireToolName(`mcp_parallel_tool_${index}`));
        });

        harness.tearDown();
    });

    it("keeps per-request tool definition state isolated under concurrent mixed prefix load", async () => {
        const harness = await createFetchHarness();
        const toolNames = [
            "read_file",
            "mcp_existing_read",
            "write_file",
            "mcp_existing_write",
            "list_files",
            "mcp_existing_list",
        ];

        harness.mockFetch.mockImplementation(() => jsonResponse({ id: "msg_mixed", content: [] }));

        await Promise.all(
            toolNames.map((toolName) =>
                harness.fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: makeRequestBody({ toolName, text: toolName }),
                }),
            ),
        );

        const transformedNames = harness.mockFetch.mock.calls.map((call) => parseSentBody(call).tools[0].name);
        expect(transformedNames).toEqual(toolNames.map(toWireToolName));

        harness.tearDown();
    });

    it("keeps historical tool_use blocks isolated under concurrent request fan-out", async () => {
        const harness = await createFetchHarness();

        harness.mockFetch.mockImplementation(() => jsonResponse({ id: "msg_history", content: [] }));

        await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                harness.fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: makeRequestBody({
                        historicalToolName: `mcp_history_tool_${index}`,
                        text: `history-${index}`,
                    }),
                }),
            ),
        );

        const transformedNames = harness.mockFetch.mock.calls.map((call) => {
            const assistantMsg = (
                parseSentBody(call).messages as Array<{ role?: string; content: Array<{ name?: string }> }>
            ).find((msg) => msg.role === "assistant");
            return assistantMsg?.content[0].name;
        });
        transformedNames.forEach((name, index) => {
            expect(name).toBe(toWireToolName(`mcp_history_tool_${index}`));
        });

        harness.tearDown();
    });

    it("clones Request input bodies before service-wide retries", async () => {
        const harness = await createFetchHarness();

        harness.mockFetch
            .mockResolvedValueOnce(new Response("temporary outage", { status: 503 }))
            .mockResolvedValueOnce(jsonResponse({ id: "msg_retry", content: [] }));

        const request = new Request("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: makeRequestBody({ toolName: "mcp_retry_body" }),
        });

        const response = await harness.fetch(request);
        await response.json();

        const firstInit = harness.mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
        const secondInit = harness.mockFetch.mock.calls[1]?.[1] as RequestInit | undefined;

        expect(typeof firstInit?.body).toBe("string");
        expect(firstInit?.body).toBe(secondInit?.body);

        harness.tearDown();
    });

    it("preserves each concurrent Request body independently across retry fan-out", async () => {
        const harness = await createFetchHarness();
        const attempts = new Map<string, number>();

        harness.mockFetch.mockImplementation((input) => {
            const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
            const attempt = attempts.get(url) ?? 0;
            attempts.set(url, attempt + 1);

            if (attempt === 0) {
                return Promise.resolve(new Response("try again", { status: 503 }));
            }

            return Promise.resolve(jsonResponse({ id: `ok:${url}`, content: [] }));
        });

        const requests = Array.from({ length: 10 }, (_, index) =>
            harness.fetch(
                new Request(`https://api.anthropic.com/v1/messages?retry=${index}`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: makeRequestBody({ toolName: `mcp_retry_parallel_${index}` }),
                }),
            ),
        );

        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.json()));

        for (let index = 0; index < 10; index += 1) {
            const callsForUrl = harness.mockFetch.mock.calls.filter((call) => callUrl(call).includes(`retry=${index}`));
            expect(callsForUrl).toHaveLength(2);
            callsForUrl.forEach((call) => {
                const init = call[1] as RequestInit | undefined;
                expect(typeof init?.body).toBe("string");
            });
        }

        harness.tearDown();
    });

    it("rotates accounts under concurrent 429 load without tool-prefix drift", async () => {
        const harness = await createFetchHarness({
            accounts: [
                {
                    email: "first@example.com",
                    access: "access-1",
                    refreshToken: "refresh-1",
                    expires: Date.now() + 60_000,
                },
                {
                    email: "second@example.com",
                    access: "access-2",
                    refreshToken: "refresh-2",
                    expires: Date.now() + 60_000,
                },
            ],
        });

        harness.mockFetch.mockImplementation((_input, init) => {
            const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
            const auth = headers.get("authorization");
            if (auth === "Bearer access-1") {
                return Promise.resolve(rateLimitResponse());
            }
            return Promise.resolve(jsonResponse({ id: "msg_rotated", content: [] }));
        });

        const responses = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                harness.fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: makeRequestBody({ toolName: `mcp_rotation_tool_${index}` }),
                }),
            ),
        );
        await Promise.all(responses.map((response) => response.json()));

        const successfulRotations = harness.mockFetch.mock.calls.filter(
            (call) => callHeaders(call).get("authorization") !== "Bearer access-1",
        );

        expect(successfulRotations).toHaveLength(12);
        successfulRotations.forEach((call) => {
            expect(parseSentBody(call).tools[0].name).not.toMatch(/^mcp_/i);
        });

        harness.tearDown();
    });

    it("shares one refresh across concurrent requests without cross-request contamination", async () => {
        const harness = await createFetchHarness({
            accounts: [
                {
                    email: "refresh@example.com",
                    access: "",
                    refreshToken: "refresh-stale",
                    expires: Date.now() - 1_000,
                },
            ],
        });
        const refreshDeferred = createDeferred<{
            access_token: string;
            expires_in: number;
            refresh_token: string;
        }>();

        mockRefreshToken.mockReturnValue(refreshDeferred.promise);
        harness.mockFetch.mockImplementation(() => jsonResponse({ id: "msg_refresh", content: [] }));

        const requests = Array.from({ length: 10 }, (_, index) =>
            harness.fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: makeRequestBody({ toolName: `mcp_refresh_tool_${index}` }),
            }),
        );

        await harness.waitFor(() => expect(mockRefreshToken).toHaveBeenCalledTimes(1), 1000);

        refreshDeferred.resolve({
            access_token: "access-fresh",
            expires_in: 3600,
            refresh_token: "refresh-fresh",
        });

        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.json()));

        harness.mockFetch.mock.calls.forEach((call, index) => {
            expect(callHeaders(call).get("authorization")).toBe("Bearer access-fresh");
            expect(parseSentBody(call).tools[0].name).toBe(toWireToolName(`mcp_refresh_tool_${index}`));
        });

        harness.tearDown();
    });

    it("keeps SSE and JSON tool-name rewriting consistent when both run concurrently", async () => {
        const harness = await createFetchHarness();

        harness.mockFetch.mockImplementation((input) => {
            const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
            if (url.includes("stream")) {
                return Promise.resolve(makeToolUseSseResponse("mcp_parallel_stream"));
            }
            return Promise.resolve(
                jsonResponse({
                    content: [
                        {
                            type: "tool_use",
                            name: "mcp_parallel_json",
                            input: { ok: true },
                        },
                    ],
                }),
            );
        });

        const [streamResponse, jsonResponseValue] = await Promise.all([
            harness.fetch("https://api.anthropic.com/v1/messages/stream", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: makeRequestBody({ toolName: "mcp_parallel_stream" }),
            }),
            harness.fetch("https://api.anthropic.com/v1/messages/json", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: makeRequestBody({ toolName: "mcp_parallel_json" }),
            }),
        ]);

        const [streamText, jsonPayload] = await Promise.all([
            streamResponse.text(),
            jsonResponseValue.json() as Promise<{ content: Array<{ name: string }> }>,
        ]);

        expect(streamText).toContain('"name":"parallel_stream"');
        expect(streamText).not.toContain('"name":"mcp_parallel_stream"');
        expect(jsonPayload.content[0].name).toBe("parallel_json");

        harness.tearDown();
    });

    it("does not leak one request error into sibling concurrent requests", async () => {
        const harness = await createFetchHarness();

        harness.mockFetch.mockImplementation((input) => {
            const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
            if (url.includes("explode")) {
                return Promise.reject(new Error("socket reset"));
            }
            return Promise.resolve(jsonResponse({ id: "msg_ok", content: [] }));
        });

        const [failed, succeeded] = await Promise.allSettled([
            harness.fetch("https://api.anthropic.com/v1/messages/explode", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: makeRequestBody({ toolName: "mcp_fail_tool" }),
            }),
            harness.fetch("https://api.anthropic.com/v1/messages/ok", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: makeRequestBody({ toolName: "mcp_ok_tool" }),
            }),
        ]);

        expect(failed.status).toBe("rejected");
        expect(succeeded.status).toBe("fulfilled");

        if (succeeded.status === "fulfilled") {
            await succeeded.value.json();
        }

        const successCall = harness.mockFetch.mock.calls.find((call) => callUrl(call).includes("/ok"));
        expect(successCall).toBeDefined();
        expect(parseSentBody(successCall!).tools[0].name).toBe(toWireToolName("mcp_ok_tool"));

        harness.tearDown();
    });

    it("does not mutate shared request payloads across concurrent batches", async () => {
        const harness = await createFetchHarness();
        const sharedBody = makeRequestBody({
            toolName: "mcp_shared_tool",
            text: "shared",
        });

        harness.mockFetch.mockImplementation(() => jsonResponse({ id: "msg_shared", content: [] }));

        const firstWave = Array.from({ length: 20 }, () =>
            harness.fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: sharedBody,
            }),
        );

        await Promise.all(firstWave);

        const followUp = await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: sharedBody,
        });
        await followUp.json();

        const lastSharedCall = harness.mockFetch.mock.calls[harness.mockFetch.mock.calls.length - 1];

        expect(JSON.parse(sharedBody).tools[0].name).toBe("mcp_shared_tool");
        expect(parseSentBody(lastSharedCall).tools[0].name).toBe(toWireToolName("mcp_shared_tool"));

        harness.tearDown();
    });

    it("cleans up retry bookkeeping after each request", async () => {
        const harness = await createFetchHarness();
        let firstRetryAttempt = true;

        harness.mockFetch.mockImplementation((input) => {
            const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
            if (url.includes("retry-once") && firstRetryAttempt) {
                firstRetryAttempt = false;
                return Promise.resolve(new Response("temporary outage", { status: 503 }));
            }
            return Promise.resolve(jsonResponse({ id: `msg:${url}`, content: [] }));
        });

        const retried = await harness.fetch("https://api.anthropic.com/v1/messages/retry-once", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: makeRequestBody({ toolName: "mcp_retry_cleanup" }),
        });
        await retried.json();

        const clean = await harness.fetch("https://api.anthropic.com/v1/messages/clean", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: makeRequestBody({ toolName: "mcp_clean_followup" }),
        });
        await clean.json();

        const cleanCall = harness.mockFetch.mock.calls.find((call) => callUrl(call).includes("/clean"));
        expect(cleanCall).toBeDefined();
        expect(callHeaders(cleanCall!).get("x-stainless-retry-count")).toBe("0");
        expect(parseSentBody(cleanCall!).tools[0].name).toBe(toWireToolName("mcp_clean_followup"));

        harness.tearDown();
    });

    it("leaves no dangling deferred work after concurrent request cleanup", async () => {
        const harness = await createFetchHarness();
        const gate = createDeferred<Response>();

        harness.mockFetch.mockImplementation(() => gate.promise);

        const pendingRequest = harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: makeRequestBody({ toolName: "mcp_cleanup_gate" }),
        });

        await nextTick();
        gate.resolve(jsonResponse({ id: "msg_cleanup_gate", content: [] }));

        const response = await pendingRequest;
        await response.json();

        harness.mockFetch.mockImplementation(() => jsonResponse({ id: "msg_cleanup_followup", content: [] }));

        const followUp = await harness.fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: makeRequestBody({ toolName: "mcp_cleanup_gate_followup" }),
        });
        await followUp.json();

        const lastCleanupCall = harness.mockFetch.mock.calls[harness.mockFetch.mock.calls.length - 1];

        expect(parseSentBody(lastCleanupCall).tools[0].name).toBe(toWireToolName("mcp_cleanup_gate_followup"));

        harness.tearDown();
    });
});
