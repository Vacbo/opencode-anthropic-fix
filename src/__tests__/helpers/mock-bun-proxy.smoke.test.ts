import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferred } from "./deferred";
import { createMockBunProxy } from "./mock-bun-proxy";

describe("mock bun proxy helper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("mocks spawn and emits the startup banner", async () => {
    const proxy = createMockBunProxy({ bannerDelay: 25 });
    const child = proxy.mockSpawn("bun", ["run", "./bun-proxy.ts", "48372"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = vi.fn();

    child.stdout?.on("data", onData);

    proxy.simulateStdoutBanner();

    expect(onData).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);

    expect(proxy.child.pid).toBe(child.pid);
    expect(onData).toHaveBeenCalledOnce();
    expect(onData.mock.calls[0][0].toString()).toContain("BUN_PROXY_PORT=48372");
  });

  it("fires exit handlers and records kill signals", () => {
    const proxy = createMockBunProxy();
    const child = proxy.mockSpawn("bun", ["run", "./bun-proxy.ts", "48372"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onExit = vi.fn();

    child.on("exit", onExit);

    proxy.simulateExit(0);
    child.kill("SIGKILL");

    expect(onExit).toHaveBeenCalledWith(0, null);
    expect(proxy.child.killSignals).toEqual(["SIGKILL"]);
  });

  it("rejects async spawn callers when configured to throw", async () => {
    const proxy = createMockBunProxy({ spawnError: new Error("spawn failed") });

    await expect((async () => proxy.mockSpawn("bun", ["run", "./bun-proxy.ts", "48372"], {}))()).rejects.toThrow(
      "spawn failed",
    );
  });

  it("tracks in-flight forwarded fetch requests without touching the network", async () => {
    const response = createDeferred<Response>();
    const forwardToMockFetch = vi.fn(() => response.promise);
    const proxy = createMockBunProxy({ forwardToMockFetch });
    const child = proxy.mockSpawn("bun", ["run", "./bun-proxy.ts", "48372"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const fetchPromise = child.forwardFetch("http://127.0.0.1:48372/", {
      method: "POST",
      headers: {
        "x-proxy-url": "https://api.anthropic.com/v1/messages",
        authorization: "Bearer test-token",
        connection: "keep-alive",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(proxy.getInFlightCount()).toBe(1);

    response.resolve(new Response("ok", { status: 200 }));

    await expect(fetchPromise).resolves.toBeInstanceOf(Response);
    expect(proxy.getInFlightCount()).toBe(0);
    expect(forwardToMockFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ hello: "world" }),
      }),
    );
  });
});
