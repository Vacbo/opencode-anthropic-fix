import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createDeferred, createDeferredQueue } from "./__tests__/helpers/deferred.js";
import { createMockBunProxy } from "./__tests__/helpers/mock-bun-proxy.js";
import type * as FsModule from "node:fs";
import type * as BunFetchModule from "./bun-fetch.js";

let execFileSyncMock: Mock;
let spawnMock: Mock;
let existsSyncMock: Mock;
let readFileSyncMock: Mock;
let statSyncMock: Mock;
let unlinkSyncMock: Mock;
let writeFileSyncMock: Mock;

const originalNodeEnv = process.env.NODE_ENV;
const originalVitest = process.env.VITEST;

vi.mock("node:child_process", () => ({
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock("node:fs", async () => {
    const actual = await vi.importActual<typeof FsModule>("node:fs");

    return {
        ...actual,
        existsSync: (...args: unknown[]) => existsSyncMock(...args),
        readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
        statSync: (...args: unknown[]) => statSyncMock(...args),
        unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
        writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    };
});

type BunFetchModuleType = Awaited<typeof BunFetchModule> & {
    createBunFetch?: (options?: { debug?: boolean; onProxyStatus?: (status: unknown) => void }) => {
        fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
        shutdown: () => Promise<void>;
        getStatus: () => unknown;
    };
};

async function readBunFetchSource(): Promise<string> {
    const fs = await vi.importActual<typeof FsModule>("node:fs");
    return fs.readFileSync(new URL("./bun-fetch.ts", import.meta.url), "utf8");
}

async function loadBunFetchModule(): Promise<BunFetchModuleType> {
    return import("./bun-fetch.js") as Promise<BunFetchModuleType>;
}

function installMockFetch(implementation?: Parameters<typeof vi.fn>[0]): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(implementation ?? (async () => new Response("native-fallback", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function getCreateBunFetch(moduleNs: BunFetchModuleType): NonNullable<BunFetchModuleType["createBunFetch"]> {
    const createBunFetch = moduleNs.createBunFetch;

    expect(createBunFetch, "T20 must export createBunFetch() for per-instance lifecycle ownership").toBeTypeOf(
        "function",
    );

    if (typeof createBunFetch !== "function") {
        throw new TypeError("createBunFetch is missing");
    }

    return createBunFetch;
}

beforeEach(async () => {
    const fs = await vi.importActual<typeof FsModule>("node:fs");

    vi.resetModules();
    vi.useRealTimers();
    vi.unstubAllGlobals();

    execFileSyncMock = vi.fn().mockReturnValue(undefined);
    spawnMock = vi.fn();
    existsSyncMock = vi.fn((filePath: unknown) => {
        if (typeof filePath === "string" && /bun-proxy\.(mjs|ts)$/.test(filePath)) {
            return true;
        }

        return fs.existsSync(filePath as Parameters<typeof fs.existsSync>[0]);
    });
    readFileSyncMock = vi.fn((...args: unknown[]) =>
        fs.readFileSync(
            args[0] as Parameters<typeof fs.readFileSync>[0],
            args[1] as Parameters<typeof fs.readFileSync>[1],
        ),
    );
    statSyncMock = vi.fn((...args: unknown[]) => fs.statSync(args[0] as Parameters<typeof fs.statSync>[0]));
    unlinkSyncMock = vi.fn();
    writeFileSyncMock = vi.fn();

    process.env.NODE_ENV = "development";
    delete process.env.VITEST;
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
    } else {
        process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalVitest === undefined) {
        delete process.env.VITEST;
    } else {
        process.env.VITEST = originalVitest;
    }
});

describe("bun-fetch source guardrails (RED until T20/T21)", () => {
    it("removes module-level proxy/process/counter state in favor of instance-owned closures", async () => {
        const source = await readBunFetchSource();

        expect(source).not.toMatch(/^let (proxyPort|proxyProcess|starting|healthCheckFails|exitHandlerRegistered)\b/m);
    });

    it("does not hard-code a fixed port, pid file, or MAX_HEALTH_FAILS singleton constants", async () => {
        const source = await readBunFetchSource();

        expect(source).not.toMatch(/\b(FIXED_PORT|PID_FILE|MAX_HEALTH_FAILS|healthCheckFails)\b/);
        expect(source).not.toContain("48372");
    });

    it("spawns Bun with --parent-pid and without passing a fixed port argument", async () => {
        const source = await readBunFetchSource();

        expect(source).toContain("--parent-pid");
        expect(source).not.toMatch(/String\(FIXED_PORT\)|48372/);
    });

    it("parses proxy banners with a line-buffered stdout reader", async () => {
        const source = await readBunFetchSource();

        expect(source).toMatch(/readline\.createInterface|createInterface\(/);
    });

    it("never calls stopBunProxy from fetchViaBun catch blocks", async () => {
        const source = await readBunFetchSource();

        expect(source).not.toMatch(/catch\s*\([^)]*\)\s*\{[\s\S]*stopBunProxy\(/);
    });

    it("uses a circuit breaker instead of a shared healthCheckFails counter", async () => {
        const source = await readBunFetchSource();

        expect(source).toMatch(/createCircuitBreaker|CircuitBreaker/);
        expect(source).not.toContain("healthCheckFails");
    });

    it("installs no global process.on handlers or process.exit calls", async () => {
        const source = await readBunFetchSource();

        expect(source).not.toMatch(/process\.on\s*\(/);
        expect(source).not.toMatch(/process\.exit\s*\(/);
    });
});

describe("createBunFetch runtime lifecycle (RED until T20)", () => {
    it("exports a createBunFetch factory with fetch/shutdown/getStatus instance API", async () => {
        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: false });

        expect(instance).toMatchObject({
            fetch: expect.any(Function),
            shutdown: expect.any(Function),
            getStatus: expect.any(Function),
        });
    });

    it("creates a new proxy per plugin instance instead of sharing module-level state", async () => {
        const proxyA = createMockBunProxy();
        const proxyB = createMockBunProxy();
        spawnMock.mockImplementationOnce(proxyA.mockSpawn).mockImplementationOnce(proxyB.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instanceA = createBunFetch({ debug: false });
        const instanceB = createBunFetch({ debug: false });

        proxyA.simulateStdoutBanner(41001);
        proxyB.simulateStdoutBanner(41002);

        await Promise.all([
            instanceA.fetch("https://example.com/a", { method: "POST", body: "a" }),
            instanceB.fetch("https://example.com/b", { method: "POST", body: "b" }),
        ]);

        expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("reuses the same proxy for sequential requests from a single instance", async () => {
        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch(async () => proxy.child.forwardFetch("https://example.com/reused", { method: "POST" }));

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: false });

        proxy.simulateStdoutBanner(41011);

        await instance.fetch("https://example.com/first", { method: "POST", body: "first" });
        await instance.fetch("https://example.com/second", { method: "POST", body: "second" });

        expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    it("parses a split BUN_PROXY_PORT banner line-by-line instead of per-chunk", async () => {
        vi.useFakeTimers();

        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        expect(moduleNs.ensureBunProxy).toBeTypeOf("function");

        const startup = moduleNs.ensureBunProxy(false);
        proxy.child.stdout.write("BUN_PROXY_");
        proxy.child.stdout.write("PORT=43123\n");

        await vi.advanceTimersByTimeAsync(5001);
        await expect(startup).resolves.toBe(43123);
    });

    it("keeps 10 concurrent sibling requests on one shared proxy without interference", async () => {
        const responses = createDeferredQueue<Response>();
        const proxy = createMockBunProxy({
            forwardToMockFetch: async () => responses.enqueue().promise,
        });
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: false });

        proxy.simulateStdoutBanner(41021);

        const requests = Array.from({ length: 10 }, (_, index) =>
            instance.fetch(`https://example.com/${index}`, {
                method: "POST",
                body: `body-${index}`,
            }),
        );

        expect(spawnMock).toHaveBeenCalledTimes(1);

        for (let index = 0; index < 10; index += 1) {
            responses.resolveNext(new Response(`ok-${index}`, { status: 200 }));
        }

        await expect(Promise.all(requests)).resolves.toHaveLength(10);
    });

    it("does not kill sibling streams or the proxy when one concurrent request fails", async () => {
        const slowSuccess = createDeferred<Response>();
        const proxy = createMockBunProxy({
            forwardToMockFetch: async (input) => {
                if (String(input).includes("/fail")) {
                    throw new Error("upstream exploded");
                }

                return slowSuccess.promise;
            },
        });
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: false });

        proxy.simulateStdoutBanner(41031);

        const goodRequest = instance.fetch("https://example.com/stream-ok", {
            method: "POST",
            body: "ok",
        });
        const badRequest = instance.fetch("https://example.com/fail", {
            method: "POST",
            body: "fail",
        });

        slowSuccess.resolve(new Response("still-open", { status: 200 }));

        await expect(goodRequest).resolves.toBeInstanceOf(Response);
        await expect(badRequest).rejects.toThrow("upstream exploded");
        expect(proxy.child.killSignals).toEqual([]);
    });

    it("falls back gracefully when Bun spawn fails without calling process.exit", async () => {
        const nativeFetch = installMockFetch(async () => new Response("native", { status: 200 }));
        spawnMock.mockImplementation(() => {
            throw new Error("spawn failed");
        });

        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
            throw new Error(`unexpected process.exit(${code ?? ""})`);
        }) as typeof process.exit);

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const onProxyStatus = vi.fn();
        const instance = createBunFetch({ debug: false, onProxyStatus });

        const response = await instance.fetch("https://example.com/native", { method: "POST", body: "native" });

        expect(await response.text()).toBe("native");
        expect(nativeFetch).toHaveBeenCalledTimes(1);
        expect(onProxyStatus).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("keeps an old instance alive for in-flight work when a new hot-reload instance is created", async () => {
        const firstResponse = createDeferred<Response>();
        const proxyA = createMockBunProxy({ forwardToMockFetch: async () => firstResponse.promise });
        const proxyB = createMockBunProxy({
            forwardToMockFetch: async () => new Response("fresh-instance", { status: 200 }),
        });
        spawnMock.mockImplementationOnce(proxyA.mockSpawn).mockImplementationOnce(proxyB.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const oldInstance = createBunFetch({ debug: false });
        const oldRequest = oldInstance.fetch("https://example.com/old", { method: "POST", body: "old" });

        proxyA.simulateStdoutBanner(41041);

        const newInstance = createBunFetch({ debug: false });
        proxyB.simulateStdoutBanner(41042);

        const newRequest = newInstance.fetch("https://example.com/new", { method: "POST", body: "new" });

        expect(proxyA.getInFlightCount()).toBe(1);
        firstResponse.resolve(new Response("old-instance-still-streaming", { status: 200 }));

        await expect(oldRequest).resolves.toBeInstanceOf(Response);
        await expect(newRequest).resolves.toBeInstanceOf(Response);
    });

    it("cleans up the current child on shutdown without clearing state for an older child exit", async () => {
        const proxyA = createMockBunProxy();
        const proxyB = createMockBunProxy();
        spawnMock.mockImplementationOnce(proxyA.mockSpawn).mockImplementationOnce(proxyB.mockSpawn);
        installMockFetch(async () => new Response("ok", { status: 200 }));

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instanceA = createBunFetch({ debug: false });
        const instanceB = createBunFetch({ debug: false });

        proxyA.simulateStdoutBanner(41051);
        proxyB.simulateStdoutBanner(41052);

        await instanceA.fetch("https://example.com/a", { method: "POST", body: "a" });
        await instanceB.fetch("https://example.com/b", { method: "POST", body: "b" });

        proxyA.simulateExit(0, null);
        await instanceB.shutdown();

        expect(proxyB.child.killSignals).toContain("SIGTERM");
        expect(proxyA.child.killSignals).toEqual([]);
    });
});

describe("createBunFetch debug request dumping", () => {
    const UNIQUE_REQUEST_PATTERN =
        /^\/tmp\/opencode-request-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.json$/;
    const UNIQUE_HEADERS_PATTERN =
        /^\/tmp\/opencode-headers-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.json$/;
    const LATEST_REQUEST_PATH = "/tmp/opencode-last-request.json";
    const LATEST_HEADERS_PATH = "/tmp/opencode-last-headers.json";

    function writtenPaths(): string[] {
        return writeFileSyncMock.mock.calls.map((call) => String(call[0]));
    }

    it("writes a uniquely-named request file AND a latest-alias file when debug=true", async () => {
        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: true });

        proxy.simulateStdoutBanner(42001);

        await instance.fetch("https://api.anthropic.com/v1/messages?beta=true", {
            method: "POST",
            body: JSON.stringify({ hello: "world" }),
        });

        const paths = writtenPaths();
        const uniqueRequest = paths.find((path) => UNIQUE_REQUEST_PATTERN.test(path));
        const uniqueHeaders = paths.find((path) => UNIQUE_HEADERS_PATTERN.test(path));

        expect(uniqueRequest, "expected a uniquely-named request dump").toBeDefined();
        expect(uniqueHeaders, "expected a uniquely-named headers dump").toBeDefined();
        expect(paths).toContain(LATEST_REQUEST_PATH);
        expect(paths).toContain(LATEST_HEADERS_PATH);
    });

    it("produces a different unique path for each sequential debug request", async () => {
        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: true });

        proxy.simulateStdoutBanner(42002);

        await instance.fetch("https://api.anthropic.com/v1/messages?beta=true", {
            method: "POST",
            body: JSON.stringify({ n: 1 }),
        });
        await instance.fetch("https://api.anthropic.com/v1/messages?beta=true", {
            method: "POST",
            body: JSON.stringify({ n: 2 }),
        });

        const uniquePaths = writtenPaths().filter((path) => UNIQUE_REQUEST_PATTERN.test(path));

        expect(uniquePaths).toHaveLength(2);
        expect(uniquePaths[0]).not.toBe(uniquePaths[1]);
    });

    it("does not dump any artifact for count_tokens requests even when debug=true", async () => {
        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: true });

        proxy.simulateStdoutBanner(42003);

        await instance.fetch("https://api.anthropic.com/v1/messages/count_tokens", {
            method: "POST",
            body: JSON.stringify({ hello: "world" }),
        });

        expect(writeFileSyncMock).not.toHaveBeenCalled();
    });

    it("does not dump any artifact when debug=false", async () => {
        const proxy = createMockBunProxy();
        spawnMock.mockImplementation(proxy.mockSpawn);
        installMockFetch();

        const moduleNs = await loadBunFetchModule();
        const createBunFetch = getCreateBunFetch(moduleNs);
        const instance = createBunFetch({ debug: false });

        proxy.simulateStdoutBanner(42004);

        await instance.fetch("https://api.anthropic.com/v1/messages?beta=true", {
            method: "POST",
            body: JSON.stringify({ hello: "world" }),
        });

        expect(writeFileSyncMock).not.toHaveBeenCalled();
    });
});
