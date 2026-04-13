import { describe, expect, it, vi } from "vitest";

import {
    chunkUtf8AtOffsets,
    contentBlockDeltaEvent,
    contentBlockStartEvent,
    contentBlockStopEvent,
    encodeSSEEvent,
    encodeSSEStream,
    makeSSEResponse,
    messageDeltaEvent,
    messageStartEvent,
    messageStopEvent,
} from "../__tests__/helpers/sse.js";
import { StreamTruncatedError, transformResponse } from "./streaming.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function joinBlocks(...blocks: string[]): string {
    return blocks.join("");
}

function encodeToolUseStartEvent(
    name: string,
    input: Record<string, unknown> = { path: "/tmp/demo.txt" },
    multiline = false,
): string {
    const payload = {
        type: "content_block_start",
        index: 0,
        content_block: {
            type: "tool_use",
            id: "toolu_123",
            name,
            input,
        },
    };

    return encodeSSEEvent({
        data: multiline ? JSON.stringify(payload, null, 2) : JSON.stringify(payload),
    });
}

function encodeInputJsonDeltaEvent(partialJson: string): string {
    return encodeSSEEvent({
        data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
                type: "input_json_delta",
                partial_json: partialJson,
            },
        }),
    });
}

function makeChunkedSSEResponse(text: string, byteOffsets: number[]): Response {
    const chunks = chunkUtf8AtOffsets(text, byteOffsets);

    return makeSSEResponse(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }
                controller.close();
            },
        }),
    );
}

function makeSSEFromByteChunks(chunks: Uint8Array[], onCancel?: (reason: unknown) => void): Response {
    return makeSSEResponse(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(chunk);
                }
                controller.close();
            },
            cancel(reason) {
                onCancel?.(reason);
            },
        }),
    );
}

function createControlledSSE(
    chunks: Uint8Array[],
    onCancel?: (reason: unknown) => void,
): {
    response: Response;
    emit(index: number): void;
    close(): void;
} {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    const response = makeSSEResponse(
        new ReadableStream<Uint8Array>({
            start(innerController) {
                controller = innerController;
            },
            cancel(reason) {
                onCancel?.(reason);
            },
        }),
    );

    return {
        response,
        emit(index: number) {
            controller?.enqueue(chunks[index]!);
        },
        close() {
            controller?.close();
        },
    };
}

async function getPromiseState<T>(promise: Promise<T>): Promise<"pending" | "fulfilled" | "rejected"> {
    let state: "pending" | "fulfilled" | "rejected" = "pending";

    void promise.then(
        () => {
            state = "fulfilled";
        },
        () => {
            state = "rejected";
        },
    );

    await Promise.resolve();
    await Promise.resolve();

    return state;
}

describe("transformResponse RED - SSE termination and framing", () => {
    it("accepts a multiline tool_use stream only when the final event is message_stop", async () => {
        const stream = joinBlocks(
            encodeSSEStream([messageStartEvent()]),
            encodeToolUseStartEvent("mcp_read_file", { path: "/tmp/demo.txt" }, true),
            encodeSSEStream([contentBlockStopEvent(0), messageDeltaEvent(), messageStopEvent()]),
        );

        const text = await transformResponse(makeSSEResponse(stream)).text();

        expect(text).toContain('"type": "message_stop"');
        expect(text).toContain('"name": "read_file"');
        expect(text).not.toContain("mcp_read_file");
    });

    it("preserves multi-byte UTF-8 payloads across chunk boundaries before message_stop", async () => {
        const stream = joinBlocks(
            encodeSSEStream([messageStartEvent()]),
            encodeToolUseStartEvent(
                "mcp_unicode_lookup",
                {
                    path: "/tmp/café-🎉.txt",
                    note: "привет мир",
                },
                true,
            ),
            encodeSSEStream([contentBlockStopEvent(0), messageStopEvent()]),
        );

        const text = await transformResponse(makeChunkedSSEResponse(stream, [1, 2, 3, 5, 8, 13, 21, 34])).text();

        expect(text).toContain("café-🎉.txt");
        expect(text).toContain("привет мир");
        expect(text).toContain('"name": "unicode_lookup"');
    });

    it("rewrites multiline data payloads as one event block instead of line-by-line", async () => {
        const stream = joinBlocks(
            encodeToolUseStartEvent("mcp_shell_exec", { command: "ls -la" }, true),
            encodeSSEStream([messageStopEvent()]),
        );

        const text = await transformResponse(makeSSEResponse(stream)).text();

        expect(text).toContain('"name": "shell_exec"');
        expect(text).not.toContain("mcp_shell_exec");
    });

    it("does not emit rewritten bytes until a split event block is complete", async () => {
        const block = encodeToolUseStartEvent("mcp_read_file", { path: "/tmp/demo.txt" }, true);
        const splitPoint = block.indexOf("\n") + 1;
        const chunks = [encoder.encode(block.slice(0, splitPoint)), encoder.encode(block.slice(splitPoint))];
        const controlled = createControlledSSE(chunks);

        const transformed = transformResponse(controlled.response);
        const reader = transformed.body!.getReader();

        controlled.emit(0);

        const firstRead = reader.read();
        expect(await getPromiseState(firstRead)).toBe("pending");

        controlled.emit(1);
        controlled.close();

        const resolved = await firstRead;
        expect(decoder.decode(resolved.value)).toContain('"name": "read_file"');
    });
});

describe("transformResponse RED - truncation and validation", () => {
    it("rejects a truncated stream that ends after message_delta without message_stop", async () => {
        const stream = encodeSSEStream([
            messageStartEvent(),
            contentBlockStartEvent(0),
            contentBlockDeltaEvent(0, "hello"),
            contentBlockStopEvent(0),
            messageDeltaEvent(),
        ]);

        const error = await transformResponse(makeSSEResponse(stream))
            .text()
            .catch((streamError: unknown) => streamError);

        expect(error).toBeInstanceOf(StreamTruncatedError);
        expect(error).toBeInstanceOf(Error);
        expect((error as StreamTruncatedError).message).toMatch(/message_stop|truncated/i);
        expect((error as StreamTruncatedError).context).toMatchObject({
            inFlightEvent: "message_delta",
            lastEventType: "message_delta",
        });
    });

    it("rejects a final message_stop event that is missing its terminating blank line", async () => {
        const completeStop = encodeSSEStream([messageStopEvent()]);
        const truncatedStop = completeStop.slice(0, -2);
        const stream = joinBlocks(encodeSSEStream([messageStartEvent()]), truncatedStop);

        await expect(transformResponse(makeSSEResponse(stream)).text()).rejects.toThrow(/truncated|terminator/i);
    });

    it("rejects an event:error terminator with a descriptive stream failure", async () => {
        const errorTerminator = encodeSSEEvent({
            event: "error",
            data: JSON.stringify({
                type: "error",
                error: {
                    type: "stream_error",
                    message: "stream aborted by upstream",
                },
            }),
        });
        const stream = joinBlocks(encodeSSEStream([messageStartEvent()]), errorTerminator);

        await expect(transformResponse(makeSSEResponse(stream)).text()).rejects.toThrow(/stream aborted by upstream/i);
    });

    it("rejects malformed JSON event blocks instead of silently ignoring them", async () => {
        const malformed = joinBlocks(
            encodeSSEStream([messageStartEvent()]),
            'event: message\ndata: {"type":"content_block_start","index":0,\n\n',
            encodeSSEStream([messageStopEvent()]),
        );

        await expect(transformResponse(makeSSEResponse(malformed)).text()).rejects.toThrow(/malformed|invalid sse/i);
    });

    it("rejects orphan content_block_delta events", async () => {
        const stream = encodeSSEStream([
            messageStartEvent(),
            contentBlockDeltaEvent(0, "orphan delta"),
            messageStopEvent(),
        ]);

        await expect(transformResponse(makeSSEResponse(stream)).text()).rejects.toThrow(/orphan|content_block_delta/i);
    });

    it("rejects orphan content_block_stop events", async () => {
        const stream = encodeSSEStream([messageStartEvent(), contentBlockStopEvent(0), messageStopEvent()]);

        await expect(transformResponse(makeSSEResponse(stream)).text()).rejects.toThrow(/orphan|content_block_stop/i);
    });

    it("rejects a truncated tool_use block at EOF", async () => {
        const stream = encodeSSEStream([
            messageStartEvent(),
            contentBlockStartEvent(0, {
                content_block: {
                    type: "tool_use",
                    id: "toolu_123",
                    name: "mcp_read_file",
                    input: { path: "/tmp/demo.txt" },
                },
            }),
            messageDeltaEvent(),
        ]);

        const error = await transformResponse(makeSSEResponse(stream))
            .text()
            .catch((streamError: unknown) => streamError);

        expect(error).toBeInstanceOf(StreamTruncatedError);
        expect((error as StreamTruncatedError).message).toMatch(/truncated/i);
        expect((error as StreamTruncatedError).context).toMatchObject({
            inFlightEvent: "content_block_start(tool_use)",
            openContentBlockIndex: 0,
            hasPartialJson: false,
        });
    });

    it("rejects incomplete input_json_delta tool payloads even if message_stop arrives", async () => {
        const stream = joinBlocks(
            encodeSSEStream([messageStartEvent()]),
            encodeSSEStream([
                contentBlockStartEvent(0, {
                    content_block: {
                        type: "tool_use",
                        id: "toolu_123",
                        name: "mcp_read_file",
                        input: {},
                    },
                }),
            ]),
            encodeInputJsonDeltaEvent('{"path":"/tmp/demo.txt"'),
            encodeSSEStream([contentBlockStopEvent(0), messageStopEvent()]),
        );

        await expect(transformResponse(makeSSEResponse(stream)).text()).rejects.toThrow(
            /partial_json|incomplete tool_use/i,
        );
    });

    it("rejects oversized unterminated event buffers before they grow unbounded", async () => {
        const oversized = `data: ${"x".repeat(256 * 1024)}`;

        await expect(transformResponse(makeSSEResponse(oversized)).text()).rejects.toThrow(
            /buffer|limit|unterminated/i,
        );
    });

    it("rejects malformed UTF-8 buffered at EOF during the final decoder flush", async () => {
        const validStream = encoder.encode(encodeSSEStream([messageStartEvent(), messageStopEvent()]));
        const invalidTail = new Uint8Array([0xc3]);
        const response = makeSSEFromByteChunks([validStream, invalidTail]);

        await expect(transformResponse(response).text()).rejects.toThrow(/utf-8|decoder|malformed/i);
    });
});

describe("transformResponse RED - stream control", () => {
    it("propagates cancel() to the upstream body reader", async () => {
        const cancelSpy = vi.fn();
        const response = makeSSEResponse(
            new ReadableStream<Uint8Array>({
                pull() {
                    return Promise.resolve();
                },
                cancel(reason) {
                    cancelSpy(reason);
                },
            }),
        );

        const transformed = transformResponse(response);
        await transformed.body!.cancel("stop-now");

        expect(cancelSpy).toHaveBeenCalledWith("stop-now");
    });

    it("bypasses the SSE transform path for non-event-stream responses", () => {
        const response = new Response(
            JSON.stringify({
                content: [{ type: "tool_use", name: "mcp_read_file" }],
            }),
            {
                headers: {
                    "content-type": "application/json",
                },
            },
        );

        const transformed = transformResponse(response);

        expect(transformed).toBe(response);
    });
});
