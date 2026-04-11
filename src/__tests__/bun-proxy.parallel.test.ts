import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeferred, nextTick } from "./helpers/deferred.js";
import { createMockBunProxy } from "./helpers/mock-bun-proxy.js";
import {
  contentBlockDeltaEvent,
  contentBlockStartEvent,
  contentBlockStopEvent,
  encodeSSEStream,
  makeSSEResponse,
  messageStartEvent,
  messageStopEvent,
} from "./helpers/sse.js";

interface ParentWatcher {
  start(): void;
  stop(): void;
}

type ParentWatcherFactory = (options: {
  parentPid: number;
  onParentExit: (exitCode?: number) => void;
  pollIntervalMs?: number;
  exitCode?: number;
}) => ParentWatcher;

interface BunProxyRequestHandlerOptions {
  fetchImpl: typeof fetch;
  allowHosts?: string[];
  requestTimeoutMs?: number;
}

interface BunProxyProcessRuntimeOptions {
  argv?: string[];
  fetchImpl?: typeof fetch;
  exit?: (code?: number) => void;
  parentWatcherFactory?: ParentWatcherFactory;
}

interface BunProxyModuleContract {
  createProxyRequestHandler(options: BunProxyRequestHandlerOptions): (request: Request) => Promise<Response>;
  createProxyProcessRuntime?(options: BunProxyProcessRuntimeOptions): ParentWatcher;
}

const bunProxySourcePath = fileURLToPath(new URL("../bun-proxy.ts", import.meta.url));
const bunProxySource = readFileSync(bunProxySourcePath, "utf-8");

async function loadBunProxyModule(): Promise<BunProxyModuleContract> {
  const modulePath = "../bun-proxy.js";
  return (await import(modulePath)) as BunProxyModuleContract;
}

async function createProxyRequestHandler(
  fetchImpl: typeof fetch,
  overrides: Partial<BunProxyRequestHandlerOptions> = {},
): Promise<(request: Request) => Promise<Response>> {
  const { createProxyRequestHandler } = await loadBunProxyModule();

  return createProxyRequestHandler({
    fetchImpl,
    allowHosts: ["api.anthropic.com", "platform.claude.com"],
    requestTimeoutMs: 50,
    ...overrides,
  });
}

function makeProxyRequest(
  requestId: number,
  overrides: {
    body?: string;
    headers?: HeadersInit;
    method?: string;
    signal?: AbortSignal;
    targetUrl?: string;
  } = {},
): Request {
  const headers = new Headers(overrides.headers);
  headers.set("x-proxy-url", overrides.targetUrl ?? "https://api.anthropic.com/v1/messages");

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Request("http://127.0.0.1/proxy", {
    method: overrides.method ?? "POST",
    headers,
    body: overrides.body ?? JSON.stringify({ requestId }),
    signal: overrides.signal,
  });
}

function makeSSETranscript(requestId: number): string {
  return encodeSSEStream([
    messageStartEvent({
      message: {
        id: `msg_${requestId}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-3-opus-20240229",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
        },
      },
    }),
    contentBlockStartEvent(0, {
      content_block: {
        type: "text",
        text: "",
      },
    }),
    contentBlockDeltaEvent(0, `stream-${requestId}-a`),
    contentBlockDeltaEvent(0, `stream-${requestId}-b`),
    contentBlockStopEvent(0),
    messageStopEvent(),
  ]);
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await nextTick();
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../parent-pid-watcher.js");
});

describe("bun-proxy parallel request contract (RED)", () => {
  it("single proxy handles 10 concurrent fetches with distinct bodies and responses", async () => {
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(async (_input, init) => new Response(String(init?.body), { status: 200 })),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, requestId) => handler(makeProxyRequest(requestId))),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(bodies).toEqual(Array.from({ length: 10 }, (_, requestId) => JSON.stringify({ requestId })));
  });

  it("single proxy handles 50 concurrent fetches with distinct bodies", async () => {
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(async (_input, init) => new Response(String(init?.body), { status: 200 })),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, requestId) => handler(makeProxyRequest(requestId))),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(bodies).toEqual(Array.from({ length: 50 }, (_, requestId) => JSON.stringify({ requestId })));
  });

  it("starts all concurrent upstream fetches in parallel without serialization", async () => {
    const deferredResponses = Array.from({ length: 50 }, () => createDeferred<Response>());
    let nextResponse = 0;
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(() => deferredResponses[nextResponse++]!.promise),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    const pendingResponses = Array.from({ length: 50 }, (_, requestId) => handler(makeProxyRequest(requestId)));

    await flushMicrotasks();

    expect(proxy.getInFlightCount()).toBe(50);

    deferredResponses.forEach((deferred, requestId) => {
      deferred.resolve(new Response(`ok-${requestId}`, { status: 200 }));
    });

    await Promise.all(pendingResponses);
  });

  it("slow request does not head-of-line block siblings", async () => {
    const slowResponse = createDeferred<Response>();
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(async (_input, init) => {
        const { requestId } = JSON.parse(String(init?.body)) as { requestId: number };
        if (requestId === 0) {
          return slowResponse.promise;
        }

        return new Response(`fast-${requestId}`, { status: 200 });
      }),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    const responses = Array.from({ length: 10 }, (_, requestId) => handler(makeProxyRequest(requestId)));
    const fastBodies = await Promise.all(
      responses.slice(1).map(async (responsePromise) => {
        const response = await responsePromise;
        return response.text();
      }),
    );

    expect(fastBodies).toEqual(Array.from({ length: 9 }, (_, index) => `fast-${index + 1}`));
    expect(proxy.getInFlightCount()).toBe(1);

    slowResponse.resolve(new Response("fast-0", { status: 200 }));

    const slowBody = await (await responses[0]).text();
    expect(slowBody).toBe("fast-0");
  });

  it("concurrent SSE streams maintain per-stream event ordering", async () => {
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(async (_input, init) => {
        const { requestId } = JSON.parse(String(init?.body)) as { requestId: number };
        return makeSSEResponse(makeSSETranscript(requestId));
      }),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, requestId) => handler(makeProxyRequest(requestId))),
    );
    const transcripts = await Promise.all(responses.map((response) => response.text()));

    transcripts.forEach((transcript, requestId) => {
      expect(transcript).toContain(`stream-${requestId}-a`);
      expect(transcript).toContain(`stream-${requestId}-b`);
      expect(transcript.indexOf(`stream-${requestId}-a`)).toBeLessThan(transcript.indexOf(`stream-${requestId}-b`));
    });
  });

  it("upstream error in 1 request does not affect siblings", async () => {
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(async (_input, init) => {
        const { requestId } = JSON.parse(String(init?.body)) as { requestId: number };
        if (requestId === 3) {
          throw new Error("boom-3");
        }

        return new Response(`ok-${requestId}`, { status: 200 });
      }),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, async (_, requestId) => {
        const response = await handler(makeProxyRequest(requestId));
        return {
          status: response.status,
          body: await response.text(),
        };
      }),
    );

    outcomes.forEach((outcome, requestId) => {
      if (requestId === 3) {
        expect(outcome.status === "rejected" || (outcome.status === "fulfilled" && outcome.value.status >= 500)).toBe(
          true,
        );
        return;
      }

      expect(outcome.status).toBe("fulfilled");
      if (outcome.status === "fulfilled") {
        expect(outcome.value).toEqual({
          status: 200,
          body: `ok-${requestId}`,
        });
      }
    });
  });

  it("upstream timeout of 1 request does not crash the proxy or cascade to later requests", async () => {
    const abortedRequestIds: number[] = [];
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const { requestId } = JSON.parse(String(init?.body)) as { requestId: number };
      const deferred = createDeferred<Response>();

      init?.signal?.addEventListener(
        "abort",
        () => {
          abortedRequestIds.push(requestId);
          deferred.reject(init.signal?.reason ?? new DOMException("Timed out", "TimeoutError"));
        },
        { once: true },
      );

      if (requestId !== 0) {
        deferred.resolve(new Response(`ok-${requestId}`, { status: 200 }));
      }

      return deferred.promise;
    }) as typeof fetch;
    const handler = await createProxyRequestHandler(fetchImpl, { requestTimeoutMs: 25 });

    const responses = Array.from({ length: 10 }, (_, requestId) => handler(makeProxyRequest(requestId)));
    const fastStatuses = await Promise.all(
      responses.slice(1).map(async (responsePromise) => {
        const response = await responsePromise;
        return response.status;
      }),
    );

    // Wait for the 25ms proxy timeout to actually fire on request 0. The
    // previous hard 50ms sleep flaked under host load (husky pre-publish,
    // lint-staged overhead, CI workers) because the abort callback would
    // not have run yet when the assertion fired. Poll for the expected
    // state with a generous upper bound instead of racing a fixed delay.
    const deadline = Date.now() + 500;
    while (abortedRequestIds.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(fastStatuses).toEqual(Array.from({ length: 9 }, () => 200));
    expect(abortedRequestIds).toEqual([0]);

    await expect(handler(makeProxyRequest(99))).resolves.toBeInstanceOf(Response);
  });

  it("canceling 1 of 10 requests aborts only that upstream signal and not siblings", async () => {
    const abortedRequestIds: number[] = [];
    const deferredResponses = new Map<number, ReturnType<typeof createDeferred<Response>>>();
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const { requestId } = JSON.parse(String(init?.body)) as { requestId: number };
      const deferred = createDeferred<Response>();

      deferredResponses.set(requestId, deferred);
      init?.signal?.addEventListener(
        "abort",
        () => {
          abortedRequestIds.push(requestId);
          deferred.reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );

      return deferred.promise;
    }) as typeof fetch;
    const handler = await createProxyRequestHandler(fetchImpl);
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const responses = Array.from({ length: 10 }, (_, requestId) =>
      handler(makeProxyRequest(requestId, { signal: controllers[requestId].signal })),
    );

    await flushMicrotasks();
    controllers[4].abort(new DOMException("client disconnected", "AbortError"));

    deferredResponses.forEach((deferred, requestId) => {
      if (requestId !== 4) {
        deferred.resolve(new Response(`ok-${requestId}`, { status: 200 }));
      }
    });

    const outcomes = await Promise.allSettled(
      responses.map(async (responsePromise) => {
        const response = await responsePromise;
        return response.status;
      }),
    );

    expect(abortedRequestIds).toEqual([4]);
    outcomes.forEach((outcome, requestId) => {
      if (requestId === 4) {
        expect(outcome.status === "rejected" || (outcome.status === "fulfilled" && outcome.value >= 400)).toBe(true);
        return;
      }

      expect(outcome).toMatchObject({
        status: "fulfilled",
        value: 200,
      });
    });
  });

  it("client disconnect aborts the upstream fetch signal", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const upstreamResponse = createDeferred<Response>();
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      init?.signal?.addEventListener(
        "abort",
        () => {
          upstreamResponse.reject(init.signal?.reason ?? new DOMException("client disconnected", "AbortError"));
        },
        { once: true },
      );

      return upstreamResponse.promise;
    }) as typeof fetch;
    const handler = await createProxyRequestHandler(fetchImpl);
    const controller = new AbortController();
    const responsePromise = handler(makeProxyRequest(123, { signal: controller.signal }));

    await flushMicrotasks();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal?.aborted).toBe(false);

    controller.abort(new DOMException("client disconnected", "AbortError"));

    await expect(responsePromise).resolves.toMatchObject({ status: 499 });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamSignal?.reason).toBeInstanceOf(DOMException);
    expect((upstreamSignal?.reason as DOMException | undefined)?.name).toBe("AbortError");
  });

  it("releases all in-flight bookkeeping after repeated bursts to keep memory bounded", async () => {
    const proxy = createMockBunProxy({
      forwardToMockFetch: vi.fn(async (_input, init) => new Response(String(init?.body), { status: 200 })),
    });
    const handler = await createProxyRequestHandler(proxy.child.forwardFetch as typeof fetch);

    for (let burst = 0; burst < 3; burst += 1) {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, requestId) => handler(makeProxyRequest(burst * 100 + requestId))),
      );
      await Promise.all(responses.map((response) => response.text()));
      expect(proxy.getInFlightCount()).toBe(0);
    }
  });

  it("ties the upstream fetch to the incoming request signal without pre-fetch body awaits or mutable globals", () => {
    expect(bunProxySource).toMatch(/AbortSignal\.any\s*\(\s*\[\s*req\.signal/i);
    expect(bunProxySource).not.toMatch(/await\s+req\.arrayBuffer\s*\(/);
    expect(bunProxySource).not.toMatch(/^let\s+/m);
  });

  it("starts a parent-PID watcher so the subprocess exits when the parent dies", async () => {
    const parentWatcher = {
      start: vi.fn(),
      stop: vi.fn(),
    } satisfies ParentWatcher;
    const parentWatcherFactory = vi.fn(({ onParentExit }: Parameters<ParentWatcherFactory>[0]) => {
      onParentExit(0);
      return parentWatcher;
    });
    const exit = vi.fn();
    const proxy = createMockBunProxy();
    const { createProxyProcessRuntime } = await loadBunProxyModule();

    const runtime = createProxyProcessRuntime?.({
      argv: ["bun", "run", "bun-proxy.ts", "--parent-pid", "4242"],
      fetchImpl: proxy.child.forwardFetch as typeof fetch,
      exit,
      parentWatcherFactory,
    });

    runtime?.start();

    expect(parentWatcherFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        parentPid: 4242,
      }),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
