#!/usr/bin/env bun

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

const HOST = "127.0.0.1";
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 60_000;
const gracefulShutdownMs = Number.parseInt(process.env.GRACEFUL_SHUTDOWN_MS ?? "", 10);
const idleShutdownMs =
    Number.isFinite(gracefulShutdownMs) && gracefulShutdownMs > 0 ? gracefulShutdownMs : DEFAULT_GRACEFUL_SHUTDOWN_MS;

type SseEvent = Record<string, unknown>;

let requestCounter = 0;
let lastActivityAt = Date.now();
const sockets = new Set<Socket>();

function touchActivity(): void {
    lastActivityAt = Date.now();
}

function nextToolUseId(): { requestNumber: number; toolUseId: string } {
    requestCounter += 1;
    return {
        requestNumber: requestCounter,
        toolUseId: `toolu_${String(requestCounter).padStart(8, "0")}`,
    };
}

function writeSseEvent(response: ServerResponse<IncomingMessage>, payload: unknown): void {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function collectRequestBody(request: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", reject);
    });
}

function scheduleSseSequence(
    response: ServerResponse<IncomingMessage>,
    requestNumber: number,
    toolUseId: string,
    requestBody: string,
): void {
    const bodyPreview = requestBody.slice(0, 120);
    const events: SseEvent[] = [
        {
            type: "message_start",
            message: {
                id: `msg_${requestNumber}`,
                type: "message",
                role: "assistant",
                content: [],
                model: "claude-sonnet-4-5",
                stop_reason: null,
                stop_sequence: null,
                usage: {
                    input_tokens: 1,
                    output_tokens: 0,
                },
            },
        },
        {
            type: "content_block_start",
            index: 0,
            content_block: {
                type: "tool_use",
                id: toolUseId,
                name: "qa_parallel_probe",
                input: {},
            },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "input_json_delta",
                partial_json: `{"request_number":${requestNumber},`,
            },
        },
        {
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "input_json_delta",
                partial_json: `"body_preview":${JSON.stringify(bodyPreview)},"ok":true}`,
            },
        },
        {
            type: "content_block_stop",
            index: 0,
        },
        {
            type: "message_delta",
            delta: {
                stop_reason: "tool_use",
                stop_sequence: null,
            },
            usage: {
                output_tokens: 1,
            },
        },
        {
            type: "message_stop",
        },
    ];

    let eventIndex = 0;

    const flushNext = (): void => {
        if (eventIndex >= events.length) {
            response.end();
            return;
        }

        writeSseEvent(response, events[eventIndex]);
        eventIndex += 1;
        setTimeout(flushNext, 2);
    };

    flushNext();
}

const server = http.createServer(async (request, response) => {
    touchActivity();

    if (request.url === "/__health") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
        return;
    }

    const requestBody = await collectRequestBody(request);
    const { requestNumber, toolUseId } = nextToolUseId();

    response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    });

    scheduleSseSequence(response, requestNumber, toolUseId, requestBody);
});

server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
        sockets.delete(socket);
        touchActivity();
    });
});

const idleTimer = setInterval(
    () => {
        if (Date.now() - lastActivityAt < idleShutdownMs) {
            return;
        }

        clearInterval(idleTimer);
        server.close(() => {
            process.exit(0);
        });
    },
    Math.min(idleShutdownMs, 1_000),
);

idleTimer.unref();

function shutdown(exitCode: number): void {
    clearInterval(idleTimer);
    for (const socket of sockets) {
        socket.destroy();
    }

    server.close(() => {
        process.exit(exitCode);
    });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

server.listen(0, HOST, () => {
    touchActivity();
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to resolve mock upstream address.");
    }
    process.stdout.write(`MOCK_UPSTREAM_PORT=${address.port}\n`);
});
