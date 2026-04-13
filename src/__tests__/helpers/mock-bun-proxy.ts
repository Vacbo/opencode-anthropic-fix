import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { vi, type Mock } from "vitest";

type ForwardFetchInput = string | URL | Request;
type ForwardFetch = (input: ForwardFetchInput, init?: RequestInit) => Promise<Response>;

type MockChildProcess = EventEmitter &
    Omit<
        ChildProcess,
        "pid" | "killed" | "exitCode" | "signalCode" | "stdout" | "stderr" | "spawnfile" | "spawnargs" | "kill"
    > & {
        killSignals: NodeJS.Signals[];
        pid: number;
        killed: boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        stdout: PassThrough;
        stderr: PassThrough;
        spawnfile: string;
        spawnargs: string[];
        kill: (signal?: number | NodeJS.Signals | null) => boolean;
        forwardFetch: ForwardFetch;
    };

export interface MockProxyOptions {
    bannerDelay?: number;
    spawnError?: Error;
    forwardToMockFetch?: ForwardFetch;
    parentDeathSimulation?: boolean;
}

export interface MockBunProxy {
    mockSpawn: Mock;
    child: MockChildProcess;
    simulateExit(code?: number | null, signal?: NodeJS.Signals | null): void;
    simulateStdoutBanner(port?: number): void;
    simulateCrash(message?: string): void;
    getInFlightCount(): number;
}

let nextPid = 48_372;

function normalizeSignal(signal?: number | NodeJS.Signals | null): NodeJS.Signals {
    return typeof signal === "string" ? signal : "SIGTERM";
}

function inferSpawnPort(args: string[]): number {
    const numericArg = [...args].reverse().find((arg) => /^\d+$/.test(arg));
    return numericArg ? Number.parseInt(numericArg, 10) : 48_372;
}

async function normalizeForwardedRequest(
    input: ForwardFetchInput,
    init?: RequestInit,
): Promise<{
    targetUrl: string;
    forwardedInit: RequestInit;
}> {
    const request =
        input instanceof Request
            ? new Request(input, init)
            : new Request(input instanceof URL ? input.toString() : input, init);
    const headers = new Headers(request.headers);
    const targetUrl = headers.get("x-proxy-url") ?? request.url;

    headers.delete("x-proxy-url");
    headers.delete("host");
    headers.delete("connection");

    const method = request.method || "GET";
    let body: RequestInit["body"] | undefined;

    if (method !== "GET" && method !== "HEAD") {
        if (init?.body !== undefined) {
            body = init.body;
        } else {
            const textBody = await request.clone().text();
            body = textBody.length > 0 ? textBody : undefined;
        }
    }

    return {
        targetUrl,
        forwardedInit: {
            method,
            headers,
            body,
        },
    };
}

export function createMockBunProxy(options: MockProxyOptions = {}): MockBunProxy {
    let inFlightCount = 0;
    let exited = false;
    let lastSpawnArgs: string[] = [];
    const pendingTimers = new Set<NodeJS.Timeout>();
    const forwardToMockFetch: ForwardFetch =
        options.forwardToMockFetch ?? (async () => new Response(null, { status: 204 }));

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as MockChildProcess;

    child.pid = nextPid++;
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = stdout;
    child.stderr = stderr;
    child.killSignals = [];
    child.spawnfile = "";
    child.spawnargs = [];
    child.kill = (signal?: number | NodeJS.Signals | null) => {
        const normalizedSignal = normalizeSignal(signal);
        child.killSignals.push(normalizedSignal);
        child.killed = true;

        if (options.parentDeathSimulation) {
            queueMicrotask(() => {
                emitExit(null, normalizedSignal);
            });
        }

        return true;
    };
    child.forwardFetch = async (input: ForwardFetchInput, init?: RequestInit): Promise<Response> => {
        inFlightCount += 1;

        try {
            const { targetUrl, forwardedInit } = await normalizeForwardedRequest(input, init);
            return await forwardToMockFetch(targetUrl, forwardedInit);
        } finally {
            inFlightCount -= 1;
        }
    };

    const clearPendingTimers = (): void => {
        for (const timer of pendingTimers) {
            clearTimeout(timer);
        }
        pendingTimers.clear();
    };

    const emitExit = (code: number | null = 0, signal: NodeJS.Signals | null = null): void => {
        if (exited) {
            return;
        }

        exited = true;
        clearPendingTimers();
        child.exitCode = code;
        child.signalCode = signal;

        child.emit("exit", code, signal);
        child.emit("close", code, signal);
        stdout.end();
        stderr.end();
    };

    const mockSpawn = vi.fn(
        (
            command: string,
            argsOrOptions?: readonly string[] | SpawnOptions,
            maybeOptions?: SpawnOptions,
        ): MockChildProcess => {
            if (options.spawnError) {
                throw options.spawnError;
            }

            const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
            const spawnOptions = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions;

            lastSpawnArgs = args;
            child.spawnfile = command;
            child.spawnargs = [command, ...args];
            void spawnOptions;

            return child;
        },
    );

    const simulateStdoutBanner = (port = inferSpawnPort(lastSpawnArgs)): void => {
        if (exited) {
            return;
        }

        const writeBanner = (): void => {
            if (!exited) {
                stdout.write(`BUN_PROXY_PORT=${port}\n`);
            }
        };

        if (!options.bannerDelay || options.bannerDelay <= 0) {
            writeBanner();
            return;
        }

        const timer = setTimeout(() => {
            pendingTimers.delete(timer);
            writeBanner();
        }, options.bannerDelay);

        timer.unref?.();
        pendingTimers.add(timer);
    };

    return {
        mockSpawn,
        child,
        simulateExit(code = 0, signal = null): void {
            emitExit(code, signal);
        },
        simulateStdoutBanner,
        simulateCrash(message = "mock bun proxy crashed"): void {
            if (exited) {
                return;
            }

            stderr.write(`${message}\n`);
            emitExit(1, null);
        },
        getInFlightCount(): number {
            return inFlightCount;
        },
    };
}
