import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ParentPidWatcher } from "./parent-pid-watcher.js";

const DEFAULT_ALLOWED_HOSTS = ["api.anthropic.com", "platform.claude.com"];
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_PARENT_EXIT_CODE = 1;
const DEFAULT_PARENT_POLL_INTERVAL_MS = 5_000;
const HEALTH_PATH = "/__health";
const DEBUG_ENABLED = process.env.OPENCODE_ANTHROPIC_DEBUG === "1";

interface ProxyRequestHandlerOptions {
  fetchImpl: typeof fetch;
  allowHosts?: string[];
  requestTimeoutMs?: number;
}

interface ProxyProcessRuntimeOptions {
  argv?: string[];
  exit?: (code?: number) => void;
  parentWatcherFactory?: ParentWatcherFactory;
}

interface ParentWatcher {
  start(): void;
  stop(): void;
}

interface ParentWatcherFactoryOptions {
  parentPid: number;
  onParentExit: (exitCode?: number) => void;
  pollIntervalMs?: number;
  exitCode?: number;
}

type ParentWatcherFactory = (options: ParentWatcherFactoryOptions) => ParentWatcher;

type RequestInitWithDuplex = RequestInit & {
  duplex?: "half";
};

interface AbortContext {
  timeoutSignal: AbortSignal;
  cancelTimeout(): void;
}

function isMainModule(argv: string[] = process.argv): boolean {
  return Boolean(argv[1]) && resolve(argv[1]) === fileURLToPath(import.meta.url);
}

function parseInteger(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseParentPid(argv: string[]): number | null {
  const inlineValue = argv
    .map((argument) => argument.match(/^--parent-pid=(\d+)$/)?.[1] ?? null)
    .find((value) => value !== null);

  if (inlineValue) {
    return parseInteger(inlineValue);
  }

  const flagIndex = argv.indexOf("--parent-pid");
  return flagIndex >= 0 ? parseInteger(argv[flagIndex + 1]) : null;
}

function createNoopWatcher(): ParentWatcher {
  return {
    start(): void {},
    stop(): void {},
  };
}

function createDefaultParentWatcherFactory(): ParentWatcherFactory {
  return ({ parentPid, onParentExit, pollIntervalMs, exitCode }): ParentWatcher =>
    new ParentPidWatcher({
      parentPid,
      pollIntervalMs,
      onParentGone: () => {
        onParentExit(exitCode);
      },
    });
}

function sanitizeForwardHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  ["x-proxy-url", "host", "connection", "content-length"].forEach((headerName) => {
    headers.delete(headerName);
  });
  return headers;
}

function copyResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  ["transfer-encoding", "content-encoding"].forEach((headerName) => {
    headers.delete(headerName);
  });
  return headers;
}

function resolveTargetUrl(req: Request, allowedHosts: ReadonlySet<string>): URL | Response {
  const targetUrl = req.headers.get("x-proxy-url");

  if (!targetUrl) {
    return new Response("Missing x-proxy-url", { status: 400 });
  }

  try {
    const parsedUrl = new URL(targetUrl);
    if (allowedHosts.size > 0 && !allowedHosts.has(parsedUrl.hostname)) {
      return new Response(`Host not allowed: ${parsedUrl.hostname}`, { status: 403 });
    }

    return parsedUrl;
  } catch {
    return new Response("Invalid x-proxy-url", { status: 400 });
  }
}

function createAbortContext(requestTimeoutMs: number): AbortContext {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort(new DOMException("Upstream request timed out", "TimeoutError"));
  }, requestTimeoutMs);

  timer.unref?.();

  return {
    timeoutSignal: timeoutController.signal,
    cancelTimeout(): void {
      clearTimeout(timer);
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError" || error.name === "TimeoutError"
    : error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function isTimeoutAbort(signal: AbortSignal): boolean {
  const reason = signal.reason;
  return reason instanceof DOMException
    ? reason.name === "TimeoutError"
    : reason instanceof Error && reason.name === "TimeoutError";
}

function createAbortResponse(req: Request, timeoutSignal: AbortSignal): Response {
  return req.signal.aborted
    ? new Response("Client disconnected", { status: 499 })
    : isTimeoutAbort(timeoutSignal)
      ? new Response("Upstream request timed out", { status: 504 })
      : new Response("Upstream request aborted", { status: 499 });
}

async function createUpstreamInit(req: Request, signal: AbortSignal): Promise<RequestInitWithDuplex> {
  const method = req.method || "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const bodyText = hasBody ? await req.text() : "";

  return {
    method,
    headers: sanitizeForwardHeaders(req.headers),
    signal,
    ...(hasBody && bodyText.length > 0 ? { body: bodyText } : {}),
  };
}

function logRequest(targetUrl: URL, req: Request): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  const logHeaders = Object.fromEntries(
    [...sanitizeForwardHeaders(req.headers).entries()].map(([key, value]) => [
      key,
      key === "authorization" ? "Bearer ***" : value,
    ]),
  );

  console.error("\n[bun-proxy] === FORWARDED REQUEST ===");
  console.error(`[bun-proxy] ${req.method} ${targetUrl.toString()}`);
  console.error(`[bun-proxy] Headers: ${JSON.stringify(logHeaders, null, 2)}`);
  console.error("[bun-proxy] =========================\n");
}

export function createProxyRequestHandler(options: ProxyRequestHandlerOptions): (req: Request) => Promise<Response> {
  const allowedHosts = new Set(options.allowHosts ?? DEFAULT_ALLOWED_HOSTS);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async function handleProxyRequest(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === HEALTH_PATH) {
      return new Response("ok");
    }

    const targetUrl = resolveTargetUrl(req, allowedHosts);
    if (targetUrl instanceof Response) {
      return targetUrl;
    }

    const abortContext = createAbortContext(requestTimeoutMs);
    const upstreamSignal = AbortSignal.any([req.signal, abortContext.timeoutSignal]);
    const upstreamInit = await createUpstreamInit(req, upstreamSignal);
    logRequest(targetUrl, req);

    try {
      const upstreamResponse = await options.fetchImpl(targetUrl.toString(), upstreamInit);
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: copyResponseHeaders(upstreamResponse.headers),
      });
    } catch (error) {
      if (upstreamSignal.aborted && isAbortError(error)) {
        return createAbortResponse(req, abortContext.timeoutSignal);
      }

      const message = error instanceof Error ? error.message : String(error);
      return new Response(message, { status: 502 });
    } finally {
      abortContext.cancelTimeout();
    }
  };
}

export function createProxyProcessRuntime(options: ProxyProcessRuntimeOptions = {}): ParentWatcher {
  const argv = options.argv ?? process.argv;
  const parentPid = parseParentPid(argv);
  if (!parentPid) {
    return createNoopWatcher();
  }

  const exit = options.exit ?? process.exit;
  const parentWatcherFactory = options.parentWatcherFactory ?? createDefaultParentWatcherFactory();

  return parentWatcherFactory({
    parentPid,
    pollIntervalMs: DEFAULT_PARENT_POLL_INTERVAL_MS,
    exitCode: DEFAULT_PARENT_EXIT_CODE,
    onParentExit: (exitCode) => {
      exit(exitCode ?? DEFAULT_PARENT_EXIT_CODE);
    },
  });
}

function assertBunRuntime(): typeof Bun {
  if (typeof Bun === "undefined") {
    throw new Error("bun-proxy.ts must be executed with Bun.");
  }

  return Bun;
}

async function runProxyProcess(): Promise<void> {
  const bun = assertBunRuntime();
  const watcher = createProxyProcessRuntime();
  const server = bun.serve({
    port: 0,
    fetch: createProxyRequestHandler({
      fetchImpl: fetch,
      allowHosts: DEFAULT_ALLOWED_HOSTS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    }),
  });

  const lifecycle = {
    closed: false,
  };

  const shutdown = (exitCode = 0): void => {
    if (lifecycle.closed) {
      return;
    }

    lifecycle.closed = true;
    watcher.stop();
    server.stop(true);
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => {
    shutdown(0);
  });

  process.on("SIGINT", () => {
    shutdown(0);
  });

  watcher.start();
  process.stdout.write(`BUN_PROXY_PORT=${server.port}\n`);
}

if (isMainModule()) {
  void runProxyProcess().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
