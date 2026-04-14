const DEFAULT_ALLOWED_HOSTS = ["api.anthropic.com", "platform.claude.com"] as const;
const HOP_BY_HOP_HEADERS = [
    "x-proxy-url",
    "host",
    "connection",
    "content-length",
    "x-proxy-disable-keepalive",
] as const;
const PROXY_DISABLE_KEEPALIVE_HEADER = "x-proxy-disable-keepalive";

type FetchInput = string | URL | Request;

type RequestInitWithDuplex = RequestInit & {
    duplex?: "half";
};

export interface ForwardAnthropicRequestOptions {
    allowedHosts?: readonly string[];
    timeoutMs?: number;
    abortSignal?: AbortSignal;
}

function resolveBunFetch(): typeof Bun.fetch {
    if (typeof Bun === "undefined" || typeof Bun.fetch !== "function") {
        throw new Error("forwardAnthropicRequest requires Bun.fetch");
    }

    return Bun.fetch.bind(Bun);
}

function toTargetUrl(input: FetchInput): URL {
    if (input instanceof URL) {
        return input;
    }

    return new URL(typeof input === "string" ? input : input.url);
}

function validateTargetUrl(input: FetchInput, allowedHosts: ReadonlySet<string>): URL {
    const targetUrl = toTargetUrl(input);
    if (allowedHosts.size > 0 && !allowedHosts.has(targetUrl.hostname)) {
        throw new Error(`Host not allowed: ${targetUrl.hostname}`);
    }

    if (targetUrl.protocol !== "https:") {
        throw new Error(`Protocol not allowed: ${targetUrl.protocol}`);
    }

    if (targetUrl.port && targetUrl.port !== "443") {
        throw new Error(`Port not allowed: ${targetUrl.port}`);
    }

    return targetUrl;
}

function sanitizeForwardHeaders(source: Headers): Headers {
    const headers = new Headers(source);
    for (const headerName of HOP_BY_HOP_HEADERS) {
        headers.delete(headerName);
    }

    return headers;
}

function validateTimeoutMs(timeoutMs: number | undefined): number | undefined {
    if (timeoutMs === undefined) {
        return undefined;
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError("timeoutMs must be a positive finite number");
    }

    return timeoutMs;
}

function collectSignals(
    input: FetchInput,
    initSignal: AbortSignal | undefined,
    abortSignal: AbortSignal | undefined,
): AbortSignal[] {
    const signals: AbortSignal[] = [];

    const addSignal = (signal: AbortSignal | undefined): void => {
        if (signal && !signals.includes(signal)) {
            signals.push(signal);
        }
    };

    addSignal(input instanceof Request ? input.signal : undefined);
    addSignal(initSignal);
    addSignal(abortSignal);

    return signals;
}

function buildUpstreamSignal(
    input: FetchInput,
    initSignal: AbortSignal | undefined,
    abortSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
): AbortSignal | undefined {
    const signals = collectSignals(input, initSignal, abortSignal);
    const validatedTimeoutMs = validateTimeoutMs(timeoutMs);

    if (validatedTimeoutMs !== undefined) {
        signals.push(AbortSignal.timeout(validatedTimeoutMs));
    }

    if (signals.length === 0) {
        return undefined;
    }

    if (signals.length === 1) {
        return signals[0];
    }

    return AbortSignal.any(signals);
}

function buildForwardRequest(input: FetchInput, init?: RequestInit): Request {
    if (input instanceof Request) {
        return new Request(input, init);
    }

    return new Request(input instanceof URL ? input.toString() : input, init);
}

function buildUpstreamInit(request: Request, signal: AbortSignal | undefined): RequestInitWithDuplex {
    const forceFreshConnection = request.headers.get(PROXY_DISABLE_KEEPALIVE_HEADER) === "true";
    const upstreamInit: RequestInitWithDuplex = {
        method: request.method,
        headers: sanitizeForwardHeaders(request.headers),
        ...(signal ? { signal } : {}),
        ...(forceFreshConnection ? { keepalive: false } : {}),
    };

    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
        upstreamInit.body = request.body;
        upstreamInit.duplex = "half";
    }

    return upstreamInit;
}

export async function forwardAnthropicRequest(
    input: FetchInput,
    init?: RequestInit,
    options: ForwardAnthropicRequestOptions = {},
): Promise<Response> {
    const request = buildForwardRequest(input, init);
    const targetUrl = validateTargetUrl(request, new Set(options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS));
    const signal = buildUpstreamSignal(input, init?.signal ?? undefined, options.abortSignal, options.timeoutMs);
    const upstreamInit = buildUpstreamInit(request, signal);

    return resolveBunFetch()(targetUrl.toString(), upstreamInit);
}
