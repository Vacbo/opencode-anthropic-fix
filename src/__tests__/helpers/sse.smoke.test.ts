import { describe, it, expect } from "vitest";
import {
    encodeSSEEvent,
    encodeSSEStream,
    chunkUtf8AtOffsets,
    makeSSEResponse,
    makeTruncatedSSEResponse,
    makeMalformedSSEResponse,
    messageStartEvent,
    contentBlockStartEvent,
    contentBlockDeltaEvent,
    contentBlockStopEvent,
    messageDeltaEvent,
    messageStopEvent,
    errorEvent,
} from "./sse";

describe("sse helpers", () => {
    describe("encodeSSEEvent", () => {
        it("formats a basic event with data", () => {
            const event = { data: "hello world" };
            const encoded = encodeSSEEvent(event);
            expect(encoded).toBe("data: hello world\n\n");
        });

        it("includes event type when provided", () => {
            const event = { event: "message", data: "hello" };
            const encoded = encodeSSEEvent(event);
            expect(encoded).toBe("event: message\ndata: hello\n\n");
        });

        it("splits multiline data into multiple data lines", () => {
            const event = { data: "line1\nline2\nline3" };
            const encoded = encodeSSEEvent(event);
            expect(encoded).toBe("data: line1\ndata: line2\ndata: line3\n\n");
        });

        it("includes id when provided", () => {
            const event = { data: "hello", id: "123" };
            const encoded = encodeSSEEvent(event);
            expect(encoded).toBe("data: hello\nid: 123\n\n");
        });

        it("includes retry when provided", () => {
            const event = { data: "hello", retry: 5000 };
            const encoded = encodeSSEEvent(event);
            expect(encoded).toBe("data: hello\nretry: 5000\n\n");
        });

        it("includes all fields when provided", () => {
            const event = { event: "message", data: "hello", id: "123", retry: 5000 };
            const encoded = encodeSSEEvent(event);
            expect(encoded).toBe("event: message\ndata: hello\nid: 123\nretry: 5000\n\n");
        });
    });

    describe("encodeSSEStream", () => {
        it("joins multiple events", () => {
            const events = [{ data: "event1" }, { data: "event2" }];
            const encoded = encodeSSEStream(events);
            expect(encoded).toBe("data: event1\n\ndata: event2\n\n");
        });

        it("returns empty string for empty events array", () => {
            const encoded = encodeSSEStream([]);
            expect(encoded).toBe("");
        });
    });

    describe("chunkUtf8AtOffsets", () => {
        it("splits ASCII text at byte offsets", () => {
            const chunks = chunkUtf8AtOffsets("hello world", [5, 8]);
            const decoder = new TextDecoder();
            expect(chunks.map((c) => decoder.decode(c))).toEqual(["hello", " wo", "rld"]);
        });

        it("handles multi-byte UTF-8 characters safely", () => {
            const chunks = chunkUtf8AtOffsets("café", [1, 2, 3]);
            const decoder = new TextDecoder();
            const decoded = chunks.map((c) => decoder.decode(c));
            expect(decoded).toEqual(["c", "a", "f", "é"]);
        });

        it("handles emoji (4-byte UTF-8)", () => {
            const chunks = chunkUtf8AtOffsets("hello 🎉 world", [5, 6]);
            const decoder = new TextDecoder();
            const decoded = chunks.map((c) => decoder.decode(c));
            expect(decoded).toEqual(["hello", " ", "🎉 world"]);
        });

        it("deduplicates and sorts offsets", () => {
            const chunks = chunkUtf8AtOffsets("hello", [3, 1, 3, 2]);
            const decoder = new TextDecoder();
            expect(chunks.map((c) => decoder.decode(c))).toEqual(["h", "e", "l", "lo"]);
        });

        it("ignores offsets beyond string length", () => {
            const chunks = chunkUtf8AtOffsets("hi", [1, 5, 10]);
            const decoder = new TextDecoder();
            expect(chunks.map((c) => decoder.decode(c))).toEqual(["h", "i"]);
        });

        it("ignores offsets at or before current position", () => {
            const chunks = chunkUtf8AtOffsets("hello", [0, 0, 1]);
            const decoder = new TextDecoder();
            expect(chunks.map((c) => decoder.decode(c))).toEqual(["h", "ello"]);
        });
    });

    describe("makeSSEResponse", () => {
        it("creates response with text/event-stream content-type", () => {
            const response = makeSSEResponse("data: hello\n\n");
            expect(response.headers.get("content-type")).toBe("text/event-stream");
            expect(response.status).toBe(200);
        });

        it("accepts custom status code", () => {
            const response = makeSSEResponse("data: hello\n\n", { status: 201 });
            expect(response.status).toBe(201);
        });

        it("accepts ReadableStream body", async () => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: hello\n\n"));
                    controller.close();
                },
            });
            const response = makeSSEResponse(stream);
            const text = await response.text();
            expect(text).toBe("data: hello\n\n");
        });
    });

    describe("makeTruncatedSSEResponse", () => {
        it("emits only specified number of events", async () => {
            const events = [{ data: "event1" }, { data: "event2" }, { data: "event3" }];
            const response = makeTruncatedSSEResponse(events, 2);
            const text = await response.text();
            expect(text).toContain("data: event1");
            expect(text).toContain("data: event2");
            expect(text).not.toContain("data: event3");
        });

        it("has text/event-stream content-type", () => {
            const events = [{ data: "event1" }];
            const response = makeTruncatedSSEResponse(events, 1);
            expect(response.headers.get("content-type")).toBe("text/event-stream");
        });
    });

    describe("makeMalformedSSEResponse", () => {
        it("emits malformed content directly", async () => {
            const response = makeMalformedSSEResponse("not valid sse");
            const text = await response.text();
            expect(text).toBe("not valid sse");
        });

        it("has text/event-stream content-type", () => {
            const response = makeMalformedSSEResponse("malformed");
            expect(response.headers.get("content-type")).toBe("text/event-stream");
        });
    });

    describe("typed event factories", () => {
        describe("messageStartEvent", () => {
            it("creates a message_start event", () => {
                const event = messageStartEvent();
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("message_start");
                expect(parsed.message.role).toBe("assistant");
            });

            it("accepts overrides", () => {
                const event = messageStartEvent({ message: { id: "custom_id" } as any });
                const parsed = JSON.parse(event.data);
                expect(parsed.message.id).toBe("custom_id");
            });
        });

        describe("contentBlockStartEvent", () => {
            it("creates a content_block_start event", () => {
                const event = contentBlockStartEvent(0);
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("content_block_start");
                expect(parsed.index).toBe(0);
            });

            it("accepts overrides", () => {
                const event = contentBlockStartEvent(1, { content_block: { type: "tool_use", name: "read_file" } });
                const parsed = JSON.parse(event.data);
                expect(parsed.index).toBe(1);
                expect(parsed.content_block.type).toBe("tool_use");
            });
        });

        describe("contentBlockDeltaEvent", () => {
            it("creates a content_block_delta event", () => {
                const event = contentBlockDeltaEvent(0, "hello");
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("content_block_delta");
                expect(parsed.delta.text).toBe("hello");
            });
        });

        describe("contentBlockStopEvent", () => {
            it("creates a content_block_stop event", () => {
                const event = contentBlockStopEvent(0);
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("content_block_stop");
                expect(parsed.index).toBe(0);
            });
        });

        describe("messageDeltaEvent", () => {
            it("creates a message_delta event", () => {
                const event = messageDeltaEvent();
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("message_delta");
                expect(parsed.delta.stop_reason).toBe("end_turn");
            });
        });

        describe("messageStopEvent", () => {
            it("creates a message_stop event", () => {
                const event = messageStopEvent();
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("message_stop");
            });
        });

        describe("errorEvent", () => {
            it("creates an error event", () => {
                const event = errorEvent("rate_limit_error", "Rate limit exceeded");
                const parsed = JSON.parse(event.data);
                expect(parsed.type).toBe("error");
                expect(parsed.error.type).toBe("rate_limit_error");
                expect(parsed.error.message).toBe("Rate limit exceeded");
            });
        });
    });
});
