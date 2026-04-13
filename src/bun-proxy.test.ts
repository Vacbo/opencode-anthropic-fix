import { describe, expect, it, vi } from "vitest";

import { createProxyRequestHandler } from "./bun-proxy.js";

function makeProxyRequest(headers?: HeadersInit): Request {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("x-proxy-url", "https://api.anthropic.com/v1/messages");
    requestHeaders.set("content-type", "application/json");

    return new Request("http://127.0.0.1/proxy", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ ok: true }),
    });
}

describe("createProxyRequestHandler", () => {
    it("forwards retry requests with keepalive disabled to the upstream fetch", async () => {
        const upstreamFetch = vi.fn(async (_input, init?: RequestInit) => {
            expect(init?.keepalive).toBe(false);
            const forwardedHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
            expect(forwardedHeaders.get("connection")).toBe("close");
            expect(forwardedHeaders.get("x-proxy-disable-keepalive")).toBeNull();
            return new Response("ok", { status: 200 });
        });
        const handler = createProxyRequestHandler({
            fetchImpl: upstreamFetch as typeof fetch,
            allowHosts: ["api.anthropic.com"],
            requestTimeoutMs: 50,
        });

        const response = await handler(makeProxyRequest({ "x-proxy-disable-keepalive": "true" }));

        await expect(response.text()).resolves.toBe("ok");
        expect(upstreamFetch).toHaveBeenCalledTimes(1);
    });
});
