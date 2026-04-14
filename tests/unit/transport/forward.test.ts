import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardAnthropicRequest } from "../../../src/transport/forward.js";

function getForwardCall(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit | undefined } {
    const call = fetchMock.mock.calls[0];

    expect(call).toBeDefined();
    if (!call) {
        throw new Error("Expected Bun.fetch to be called");
    }

    const [url, init] = call as [unknown, unknown];

    expect(url).toBeTypeOf("string");
    return {
        url: String(url),
        init: init as RequestInit | undefined,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("forwardAnthropicRequest", () => {
    it("rejects targets outside the Anthropic allowlist", async () => {
        const bunFetch = vi.fn();
        vi.stubGlobal("Bun", { fetch: bunFetch });

        await expect(forwardAnthropicRequest("https://example.com/v1/messages")).rejects.toThrow(
            /Host not allowed: example\.com/,
        );
        expect(bunFetch).not.toHaveBeenCalled();
    });

    it("rejects http protocol", async () => {
        const bunFetch = vi.fn();
        vi.stubGlobal("Bun", { fetch: bunFetch });

        await expect(forwardAnthropicRequest("http://api.anthropic.com/v1/messages")).rejects.toThrow(
            /Protocol not allowed/,
        );
        expect(bunFetch).not.toHaveBeenCalled();
    });

    it("rejects non-standard ports", async () => {
        const bunFetch = vi.fn();
        vi.stubGlobal("Bun", { fetch: bunFetch });

        await expect(forwardAnthropicRequest("https://api.anthropic.com:8443/v1/messages")).rejects.toThrow(
            /Port not allowed/,
        );
        expect(bunFetch).not.toHaveBeenCalled();
    });

    it("sanitizes hop-by-hop headers and maps keepalive opt-out", async () => {
        const bunFetch = vi.fn(async () => new Response("ok", { status: 200 }));
        vi.stubGlobal("Bun", { fetch: bunFetch });

        const response = await forwardAnthropicRequest("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                authorization: "Bearer test-token",
                connection: "keep-alive",
                "content-length": "999",
                host: "127.0.0.1",
                "x-proxy-disable-keepalive": "true",
                "x-proxy-url": "https://platform.claude.com/api/test",
            },
            body: JSON.stringify({ ok: true }),
        });

        expect(await response.text()).toBe("ok");
        expect(bunFetch).toHaveBeenCalledTimes(1);

        const { url, init } = getForwardCall(bunFetch);
        const headers = new Headers(init?.headers);

        expect(url).toBe("https://api.anthropic.com/v1/messages");
        expect(init?.keepalive).toBe(false);
        expect(headers.get("authorization")).toBe("Bearer test-token");
        expect(headers.get("connection")).toBeNull();
        expect(headers.get("content-length")).toBeNull();
        expect(headers.get("host")).toBeNull();
        expect(headers.get("x-proxy-disable-keepalive")).toBeNull();
        expect(headers.get("x-proxy-url")).toBeNull();
    });

    it("propagates timeoutMs via AbortSignal.timeout", async () => {
        const bunFetch = vi.fn(async () => new Response("ok", { status: 200 }));
        const timeoutSignal = new AbortController().signal;
        vi.stubGlobal("Bun", { fetch: bunFetch });

        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);

        await forwardAnthropicRequest(
            "https://platform.claude.com/api/organizations/test/chat_conversations",
            undefined,
            { timeoutMs: 2_500 },
        );

        expect(timeoutSpy).toHaveBeenCalledWith(2_500);
        const { init } = getForwardCall(bunFetch);
        expect(init?.signal).toBe(timeoutSignal);
    });

    it("passes through an explicit abort signal", async () => {
        const bunFetch = vi.fn(async () => new Response("ok", { status: 200 }));
        const abortController = new AbortController();
        vi.stubGlobal("Bun", { fetch: bunFetch });

        await forwardAnthropicRequest("https://api.anthropic.com/v1/messages", undefined, {
            abortSignal: abortController.signal,
        });

        const { init } = getForwardCall(bunFetch);
        expect(init?.signal).toBe(abortController.signal);
    });

    it("combines timeout and caller abort signals", async () => {
        const bunFetch = vi.fn(async () => new Response("ok", { status: 200 }));
        const timeoutSignal = new AbortController().signal;
        const callerSignal = new AbortController().signal;
        const combinedSignal = new AbortController().signal;
        vi.stubGlobal("Bun", { fetch: bunFetch });

        vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
        const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(combinedSignal);

        await forwardAnthropicRequest("https://api.anthropic.com/v1/messages", undefined, {
            timeoutMs: 1_000,
            abortSignal: callerSignal,
        });

        expect(anySpy).toHaveBeenCalledWith([callerSignal, timeoutSignal]);
        const { init } = getForwardCall(bunFetch);
        expect(init?.signal).toBe(combinedSignal);
    });
});
