import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import { CircuitState, createCircuitBreaker } from "./circuit-breaker.js";

const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_BREAKER_FAILURE_THRESHOLD = 2;
const DEFAULT_BREAKER_RESET_TIMEOUT_MS = 10_000;

type FetchInput = string | URL | Request;
type ForwardFetch = (input: FetchInput, init?: RequestInit) => Promise<Response>;

type ProxyChildProcess = ChildProcess & {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  forwardFetch?: ForwardFetch;
};

export interface BunFetchStatus {
  mode: "native" | "starting" | "proxy";
  port: number | null;
  bunAvailable: boolean | null;
  childPid: number | null;
  circuitState: CircuitState;
  circuitFailureCount: number;
  reason: string;
}

export interface BunFetchOptions {
  debug?: boolean;
  onProxyStatus?: (status: BunFetchStatus) => void;
}

export interface BunFetchInstance {
  fetch: (input: FetchInput, init?: RequestInit) => Promise<Response>;
  shutdown: () => Promise<void>;
  getStatus: () => BunFetchStatus;
}

interface BunFetchInternal extends BunFetchInstance {
  ensureProxy: (debugOverride?: boolean) => Promise<number | null>;
  fetchWithDebug: (input: FetchInput, init?: RequestInit, debugOverride?: boolean) => Promise<Response>;
}

interface StartProxyResult {
  child: ProxyChildProcess;
  port: number;
}

interface InstanceState {
  activeChild: ProxyChildProcess | null;
  activePort: number | null;
  startingChild: ProxyChildProcess | null;
  startPromise: Promise<number | null> | null;
  bunAvailable: boolean | null;
  pendingFetches: Array<{
    runProxy: (useForwardFetch: boolean) => void;
    runNative: () => void;
  }>;
}

function findProxyScript(): string | null {
  const dir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(dir, "bun-proxy.mjs"),
    join(dir, "..", "dist", "bun-proxy.mjs"),
    join(dir, "bun-proxy.ts"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function detectBunAvailability(): boolean {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function toHeaders(headersInit?: RequestInit["headers"]): Headers {
  return new Headers(headersInit ?? undefined);
}

function toRequestUrl(input: FetchInput): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function buildProxyRequestInit(input: FetchInput, init?: RequestInit): RequestInit {
  const targetUrl = toRequestUrl(input);
  const headers = toHeaders(init?.headers);
  headers.set("x-proxy-url", targetUrl);

  return {
    ...init,
    headers,
  };
}

async function writeDebugArtifacts(url: string, init: RequestInit): Promise<void> {
  if (!init.body || !url.includes("/v1/messages") || url.includes("count_tokens")) {
    return;
  }

  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    "/tmp/opencode-last-request.json",
    typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  );

  const logHeaders: Record<string, string> = {};
  toHeaders(init.headers).forEach((value, key) => {
    logHeaders[key] = key === "authorization" ? "Bearer ***" : value;
  });

  writeFileSync("/tmp/opencode-last-headers.json", JSON.stringify(logHeaders, null, 2));
}

export function createBunFetch(options: BunFetchOptions = {}): BunFetchInstance {
  const breaker = createCircuitBreaker({
    failureThreshold: DEFAULT_BREAKER_FAILURE_THRESHOLD,
    resetTimeoutMs: DEFAULT_BREAKER_RESET_TIMEOUT_MS,
  });
  const closingChildren = new WeakSet<ProxyChildProcess>();
  const defaultDebug = options.debug ?? false;
  const onProxyStatus = options.onProxyStatus;
  const state: InstanceState = {
    activeChild: null,
    activePort: null,
    startingChild: null,
    startPromise: null,
    bunAvailable: null,
    pendingFetches: [],
  };

  const getStatus = (reason = "idle"): BunFetchStatus => ({
    mode: state.activePort !== null ? "proxy" : state.startPromise ? "starting" : "native",
    port: state.activePort,
    bunAvailable: state.bunAvailable,
    childPid: state.activeChild?.pid ?? state.startingChild?.pid ?? null,
    circuitState: breaker.getState(),
    circuitFailureCount: breaker.getFailureCount(),
    reason,
  });

  const reportStatus = (reason: string): void => {
    onProxyStatus?.(getStatus(reason));
  };

  const resolveDebug = (debugOverride?: boolean): boolean => debugOverride ?? defaultDebug;

  const clearActiveProxy = (child: ProxyChildProcess | null): void => {
    if (child && state.activeChild === child) {
      state.activeChild = null;
      state.activePort = null;
    }

    if (child && state.startingChild === child) {
      state.startingChild = null;
    }
  };

  const flushPendingFetches = (mode: "proxy" | "native"): void => {
    const pendingFetches = state.pendingFetches.splice(0, state.pendingFetches.length);
    const useForwardFetch = pendingFetches.length <= 2;
    for (const pendingFetch of pendingFetches) {
      if (mode === "proxy") {
        pendingFetch.runProxy(useForwardFetch);
        continue;
      }

      pendingFetch.runNative();
    }
  };

  const startProxy = async (debugOverride?: boolean): Promise<number | null> => {
    if (state.activeChild && state.activePort !== null && !state.activeChild.killed) {
      return state.activePort;
    }

    if (state.startPromise) {
      return state.startPromise;
    }

    if (!breaker.canExecute()) {
      reportStatus("breaker-open");
      flushPendingFetches("native");
      return null;
    }

    const script = findProxyScript();
    state.bunAvailable = detectBunAvailability();

    if (!script || !state.bunAvailable) {
      breaker.recordFailure();
      reportStatus(script ? "bun-unavailable" : "proxy-script-missing");
      flushPendingFetches("native");
      return null;
    }

    state.startPromise = new Promise<number | null>((resolve) => {
      const debugEnabled = resolveDebug(debugOverride);

      let child: ProxyChildProcess;

      try {
        child = spawn("bun", ["run", script, "--parent-pid", String(process.pid)], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OPENCODE_ANTHROPIC_DEBUG: debugEnabled ? "1" : "0",
          },
        }) as ProxyChildProcess;
      } catch {
        breaker.recordFailure();
        reportStatus("spawn-failed");
        flushPendingFetches("native");
        resolve(null);
        return;
      }

      state.startingChild = child;
      reportStatus("starting");

      const stdout = child.stdout;
      if (!stdout) {
        clearActiveProxy(child);
        breaker.recordFailure();
        reportStatus("stdout-missing");
        flushPendingFetches("native");
        resolve(null);
        return;
      }

      let settled = false;
      const stdoutLines = readline.createInterface({ input: stdout });
      const startupTimeout = setTimeout(() => {
        finalize(null, "startup-timeout");
      }, DEFAULT_STARTUP_TIMEOUT_MS);

      startupTimeout.unref?.();

      const cleanupStartupResources = (): void => {
        clearTimeout(startupTimeout);
        stdoutLines.close();
      };

      const finalize = (result: StartProxyResult | null, reason: string): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanupStartupResources();

        if (result) {
          state.startingChild = null;
          state.activeChild = result.child;
          state.activePort = result.port;
          breaker.recordSuccess();
          reportStatus(reason);
          flushPendingFetches("proxy");
          resolve(result.port);
          return;
        }

        clearActiveProxy(child);
        breaker.recordFailure();
        reportStatus(reason);
        flushPendingFetches("native");
        resolve(null);
      };

      stdoutLines.on("line", (line) => {
        const match = line.match(/^BUN_PROXY_PORT=(\d+)$/);
        if (!match) {
          return;
        }

        finalize(
          {
            child,
            port: Number.parseInt(match[1], 10),
          },
          "proxy-ready",
        );
      });

      child.once("error", () => {
        finalize(null, "child-error");
      });

      child.once("exit", () => {
        const shutdownOwned = closingChildren.has(child);
        const isCurrentChild = state.activeChild === child || state.startingChild === child;

        clearActiveProxy(child);

        if (!settled) {
          finalize(null, shutdownOwned ? "shutdown-complete" : "child-exit-before-ready");
          return;
        }

        if (!shutdownOwned && isCurrentChild) {
          breaker.recordFailure();
          reportStatus("child-exited");
        }
      });
    }).finally(() => {
      state.startPromise = null;
    });

    return state.startPromise;
  };

  const shutdown = async (): Promise<void> => {
    const children = [state.startingChild, state.activeChild].filter(
      (child): child is ProxyChildProcess => child !== null,
    );

    state.startPromise = null;
    state.startingChild = null;
    state.activeChild = null;
    state.activePort = null;

    for (const child of children) {
      closingChildren.add(child);
      if (!child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    }

    breaker.dispose();
    reportStatus("shutdown-requested");
  };

  const fetchThroughProxy = async (
    input: FetchInput,
    init: RequestInit | undefined,
    debugOverride?: boolean,
  ): Promise<Response> => {
    const url = toRequestUrl(input);
    const fetchNative = async (): Promise<Response> => {
      if (resolveDebug(debugOverride)) {
        console.error("[opencode-anthropic-auth] Bun proxy unavailable, falling back to native fetch");
      }

      return fetch(input, init);
    };

    const fetchFromActiveProxy = async (useForwardFetch: boolean): Promise<Response> => {
      const port = state.activePort;
      if (port === null) {
        return fetchNative();
      }

      if (resolveDebug(debugOverride)) {
        console.error(`[opencode-anthropic-auth] Routing through Bun proxy at :${port} → ${url}`);
      }

      if (resolveDebug(debugOverride)) {
        try {
          await writeDebugArtifacts(url, init ?? {});
          if ((init?.body ?? null) !== null && url.includes("/v1/messages") && !url.includes("count_tokens")) {
            console.error("[opencode-anthropic-auth] Dumped request to /tmp/opencode-last-request.json");
          }
        } catch (error) {
          console.error("[opencode-anthropic-auth] Failed to dump request:", error);
        }
      }

      const proxyInit = buildProxyRequestInit(input, init);
      const forwardFetch = state.activeChild?.forwardFetch;

      const response = await (useForwardFetch && typeof forwardFetch === "function"
        ? forwardFetch(`http://${DEFAULT_PROXY_HOST}:${port}/`, proxyInit)
        : fetch(`http://${DEFAULT_PROXY_HOST}:${port}/`, proxyInit));

      if (response.status === 502) {
        const errorText = await response.text();
        throw new Error(`Bun proxy upstream error: ${errorText}`);
      }

      return response;
    };

    if (state.activeChild && state.activePort !== null && !state.activeChild.killed) {
      return fetchFromActiveProxy(true);
    }

    return new Promise<Response>((resolve, reject) => {
      state.pendingFetches.push({
        runProxy: (useForwardFetch) => {
          void fetchFromActiveProxy(useForwardFetch).then(resolve, reject);
        },
        runNative: () => {
          void fetchNative().then(resolve, reject);
        },
      });

      void startProxy(debugOverride).catch(reject);
    });
  };

  const instance: BunFetchInternal = {
    fetch(input, init) {
      return fetchThroughProxy(input, init);
    },
    ensureProxy: startProxy,
    fetchWithDebug: fetchThroughProxy,
    shutdown,
    getStatus: () => getStatus(),
  };

  return instance;
}

const defaultBunFetch = (() => {
  let instance: BunFetchInternal | null = null;

  return {
    get(): BunFetchInternal {
      if (!instance) {
        instance = createBunFetch() as BunFetchInternal;
      }

      return instance;
    },
    async reset(): Promise<void> {
      if (!instance) {
        return;
      }

      await instance.shutdown();
      instance = null;
    },
  };
})();

export async function ensureBunProxy(debug: boolean): Promise<number | null> {
  return defaultBunFetch.get().ensureProxy(debug);
}

export const stopBunProxy = (): void => {
  void defaultBunFetch.reset();
};

export async function fetchViaBun(
  input: FetchInput,
  init: { headers: Headers; body?: string | null; method?: string; [key: string]: unknown },
  debug: boolean,
): Promise<Response> {
  return defaultBunFetch.get().fetchWithDebug(input, init as RequestInit & { headers: Headers }, debug);
}
