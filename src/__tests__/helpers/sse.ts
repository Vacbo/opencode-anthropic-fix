export interface SSEEvent {
    event?: string;
    data: string;
    id?: string;
    retry?: number;
}

export interface MessageStartEvent {
    type: "message_start";
    message: {
        id: string;
        type: "message";
        role: "assistant";
        content: unknown[];
        model: string;
        stop_reason: null;
        stop_sequence: null;
        usage: {
            input_tokens: number;
            output_tokens: number;
        };
    };
}

export interface ContentBlockStartEvent {
    type: "content_block_start";
    index: number;
    content_block: {
        type: "text" | "tool_use";
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
    };
}

export interface ContentBlockDeltaEvent {
    type: "content_block_delta";
    index: number;
    delta: {
        type: "text_delta" | "input_json_delta";
        text?: string;
        partial_json?: string;
    };
}

export interface ContentBlockStopEvent {
    type: "content_block_stop";
    index: number;
}

export interface MessageDeltaEvent {
    type: "message_delta";
    delta: {
        stop_reason: string | null;
        stop_sequence: string | null;
    };
    usage: {
        output_tokens: number;
    };
}

export interface MessageStopEvent {
    type: "message_stop";
}

export interface ErrorEvent {
    type: "error";
    error: {
        type: string;
        message: string;
    };
}

export function encodeSSEEvent(event: SSEEvent): string {
    const lines: string[] = [];

    if (event.event) {
        lines.push(`event: ${event.event}`);
    }

    const dataLines = event.data.split("\n");
    for (const line of dataLines) {
        lines.push(`data: ${line}`);
    }

    if (event.id !== undefined) {
        lines.push(`id: ${event.id}`);
    }

    if (event.retry !== undefined) {
        lines.push(`retry: ${event.retry}`);
    }

    lines.push("", "");

    return lines.join("\n");
}

export function encodeSSEStream(events: SSEEvent[]): string {
    return events.map(encodeSSEEvent).join("");
}

export function chunkUtf8AtOffsets(text: string, byteOffsets: number[]): Uint8Array[] {
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode(text);
    const chunks: Uint8Array[] = [];

    const sortedOffsets = [...new Set(byteOffsets)].sort((a, b) => a - b);

    let currentByte = 0;

    for (const offset of sortedOffsets) {
        if (offset <= currentByte || offset > fullBytes.length) {
            continue;
        }

        let endByte = offset;
        while (endByte < fullBytes.length) {
            const byte = fullBytes[endByte];
            if ((byte & 0xc0) !== 0x80) {
                break;
            }
            endByte++;
        }

        const chunk = fullBytes.slice(currentByte, endByte);
        chunks.push(chunk);
        currentByte = endByte;
    }

    if (currentByte < fullBytes.length) {
        chunks.push(fullBytes.slice(currentByte));
    }

    return chunks;
}

export function makeSSEResponse(body: ReadableStream<Uint8Array> | string, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers as unknown as string[][] | Record<string, string> | undefined);
    headers.set("content-type", "text/event-stream");

    return new Response(body, {
        ...init,
        status: init?.status ?? 200,
        headers,
    });
}

export function makeTruncatedSSEResponse(events: SSEEvent[], emitCount: number, init?: ResponseInit): Response {
    const eventsToEmit = events.slice(0, emitCount);
    const streamBody = encodeSSEStream(eventsToEmit);

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const chunks = chunkUtf8AtOffsets(streamBody, [1024, 2048, 4096]);
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });

    return makeSSEResponse(stream, init);
}

export function makeMalformedSSEResponse(malformedContent: string, init?: ResponseInit): Response {
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(malformedContent));
            controller.close();
        },
    });

    return makeSSEResponse(stream, init);
}

export function messageStartEvent(overrides: Partial<MessageStartEvent> = {}): SSEEvent {
    const defaultEvent: MessageStartEvent = {
        type: "message_start",
        message: {
            id: "msg_123",
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
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}

export function contentBlockStartEvent(index: number, overrides: Partial<ContentBlockStartEvent> = {}): SSEEvent {
    const defaultEvent: ContentBlockStartEvent = {
        type: "content_block_start",
        index,
        content_block: {
            type: "text",
            text: "",
        },
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}

export function contentBlockDeltaEvent(
    index: number,
    text: string,
    overrides: Partial<ContentBlockDeltaEvent> = {},
): SSEEvent {
    const defaultEvent: ContentBlockDeltaEvent = {
        type: "content_block_delta",
        index,
        delta: {
            type: "text_delta",
            text,
        },
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}

export function contentBlockStopEvent(index: number, overrides: Partial<ContentBlockStopEvent> = {}): SSEEvent {
    const defaultEvent: ContentBlockStopEvent = {
        type: "content_block_stop",
        index,
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}

export function messageDeltaEvent(overrides: Partial<MessageDeltaEvent> = {}): SSEEvent {
    const defaultEvent: MessageDeltaEvent = {
        type: "message_delta",
        delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
        },
        usage: {
            output_tokens: 100,
        },
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}

export function messageStopEvent(overrides: Partial<MessageStopEvent> = {}): SSEEvent {
    const defaultEvent: MessageStopEvent = {
        type: "message_stop",
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}

export function errorEvent(errorType: string, message: string, overrides: Partial<ErrorEvent> = {}): SSEEvent {
    const defaultEvent: ErrorEvent = {
        type: "error",
        error: {
            type: errorType,
            message,
        },
    };

    return {
        data: JSON.stringify({ ...defaultEvent, ...overrides }),
    };
}
