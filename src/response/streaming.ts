// ---------------------------------------------------------------------------
// Response streaming helpers
// ---------------------------------------------------------------------------

import { isAccountSpecificError, parseRateLimitReason } from "../backoff.js";
import type { UsageStats } from "../types.js";
import { stripMcpPrefixFromParsedEvent } from "./mcp.js";

const MAX_UNTERMINATED_SSE_BUFFER = 256 * 1024;

interface OpenContentBlockState {
  type: string;
  partialJson: string;
}

interface StreamTruncatedContext {
  inFlightEvent?: string;
  lastEventType?: string;
  openContentBlockIndex?: number;
  hasPartialJson?: boolean;
}

export class StreamTruncatedError extends Error {
  readonly context: StreamTruncatedContext;

  constructor(message: string, context: StreamTruncatedContext = {}) {
    super(message);
    this.name = "StreamTruncatedError";
    this.context = context;
  }
}

/**
 * Update running usage stats from a parsed SSE event.
 */
export function extractUsageFromSSEEvent(parsed: unknown, stats: UsageStats): void {
  const p = parsed as Record<string, unknown> | null;
  if (!p) return;

  // message_delta: cumulative usage (preferred, overwrites)
  if (p.type === "message_delta" && p.usage) {
    const u = p.usage as Record<string, unknown>;
    if (typeof u.input_tokens === "number") stats.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") stats.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") stats.cacheReadTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") stats.cacheWriteTokens = u.cache_creation_input_tokens;
    return;
  }

  // message_start: initial usage (only set if we haven't seen message_delta yet)
  if (p.type === "message_start") {
    const msg = p.message as Record<string, unknown> | undefined;
    if (msg?.usage) {
      const u = msg.usage as Record<string, unknown>;
      if (stats.inputTokens === 0 && typeof u.input_tokens === "number") {
        stats.inputTokens = u.input_tokens;
      }
      if (stats.cacheReadTokens === 0 && typeof u.cache_read_input_tokens === "number") {
        stats.cacheReadTokens = u.cache_read_input_tokens;
      }
      if (stats.cacheWriteTokens === 0 && typeof u.cache_creation_input_tokens === "number") {
        stats.cacheWriteTokens = u.cache_creation_input_tokens;
      }
    }
  }
}

/**
 * Extract the combined SSE data payload from one event block.
 */
export function getSSEDataPayload(eventBlock: string): string | null {
  if (!eventBlock) return null;

  const dataLines: string[] = [];
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice(5).trimStart());
  }

  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (!payload || payload === "[DONE]") return null;
  return payload;
}

function getSSEEventType(eventBlock: string): string | null {
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("event:")) continue;
    const eventType = line.slice(6).trimStart();
    if (eventType) return eventType;
  }

  return null;
}

function formatSSEEventBlock(eventType: string, parsed: unknown, prettyPrint: boolean): string {
  const json = prettyPrint ? JSON.stringify(parsed, null, 2) : JSON.stringify(parsed);
  const lines = [`event: ${eventType}`];

  for (const line of json.split("\n")) {
    lines.push(`data: ${line}`);
  }

  lines.push("", "");
  return lines.join("\n");
}

function hasRecordedUsage(stats: UsageStats): boolean {
  return stats.inputTokens > 0 || stats.outputTokens > 0 || stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0;
}

function getErrorMessage(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") {
    return "stream terminated with error event";
  }

  const error = (parsed as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return "stream terminated with error event";
  }

  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message ? message : "stream terminated with error event";
}

function getEventIndex(parsed: Record<string, unknown>, eventType: string): number {
  const index = parsed.index;
  if (typeof index !== "number") {
    throw new Error(`invalid SSE ${eventType} event: missing numeric index`);
  }

  return index;
}

function getEventLabel(parsed: Record<string, unknown>, eventType: string): string {
  switch (eventType) {
    case "content_block_start": {
      const contentBlock = parsed.content_block;
      const blockType =
        contentBlock && typeof contentBlock === "object" ? (contentBlock as Record<string, unknown>).type : undefined;
      return typeof blockType === "string" && blockType ? `content_block_start(${blockType})` : eventType;
    }

    case "content_block_delta": {
      const delta = parsed.delta;
      const deltaType = delta && typeof delta === "object" ? (delta as Record<string, unknown>).type : undefined;
      return typeof deltaType === "string" && deltaType ? `content_block_delta(${deltaType})` : eventType;
    }

    default:
      return eventType;
  }
}

function getOpenBlockContext(openContentBlocks: Map<number, OpenContentBlockState>): StreamTruncatedContext | null {
  for (const [index, blockState] of openContentBlocks) {
    if (blockState.type === "tool_use") {
      return {
        inFlightEvent: blockState.partialJson
          ? "content_block_delta(input_json_delta)"
          : "content_block_start(tool_use)",
        openContentBlockIndex: index,
        hasPartialJson: blockState.partialJson.length > 0,
      };
    }
  }

  const firstOpenBlock = openContentBlocks.entries().next().value as [number, OpenContentBlockState] | undefined;
  if (!firstOpenBlock) {
    return null;
  }

  const [index, blockState] = firstOpenBlock;
  return {
    inFlightEvent: `content_block_start(${blockState.type})`,
    openContentBlockIndex: index,
    hasPartialJson: blockState.partialJson.length > 0,
  };
}

function createStreamTruncatedError(context: StreamTruncatedContext = {}): StreamTruncatedError {
  return new StreamTruncatedError("Stream truncated without message_stop", context);
}

function getBufferedEventContext(eventBlock: string, lastEventType: string | null): StreamTruncatedContext {
  const context: StreamTruncatedContext = {
    lastEventType: lastEventType ?? undefined,
  };

  const payload = getSSEDataPayload(eventBlock);
  if (!payload) {
    return context;
  }

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const eventType = getSSEEventType(eventBlock) ?? (typeof parsed.type === "string" ? parsed.type : null);
    if (eventType) {
      context.inFlightEvent = getEventLabel(parsed, eventType);
    }
  } catch {}

  return context;
}

function validateEventState(
  parsed: Record<string, unknown>,
  eventType: string,
  openContentBlocks: Map<number, OpenContentBlockState>,
): void {
  switch (eventType) {
    case "content_block_start": {
      const index = getEventIndex(parsed, eventType);
      const contentBlock = parsed.content_block;
      if (!contentBlock || typeof contentBlock !== "object") {
        throw new Error("invalid SSE content_block_start event: missing content_block");
      }

      if (openContentBlocks.has(index)) {
        throw new Error(`duplicate content_block_start for index ${index}`);
      }

      const blockType = (contentBlock as Record<string, unknown>).type;
      if (typeof blockType !== "string" || !blockType) {
        throw new Error("invalid SSE content_block_start event: missing content_block.type");
      }

      openContentBlocks.set(index, {
        type: blockType,
        partialJson: "",
      });
      return;
    }

    case "content_block_delta": {
      const index = getEventIndex(parsed, eventType);
      const blockState = openContentBlocks.get(index);
      if (!blockState) {
        throw new Error(`orphan content_block_delta for index ${index}`);
      }

      const delta = parsed.delta;
      if (!delta || typeof delta !== "object") {
        throw new Error("invalid SSE content_block_delta event: missing delta");
      }

      const deltaType = (delta as Record<string, unknown>).type;
      if (deltaType === "input_json_delta") {
        if (blockState.type !== "tool_use") {
          throw new Error(`orphan input_json_delta for non-tool_use block ${index}`);
        }

        const partialJson = (delta as Record<string, unknown>).partial_json;
        if (typeof partialJson !== "string") {
          throw new Error("invalid SSE content_block_delta event: missing delta.partial_json");
        }

        blockState.partialJson += partialJson;
      }

      return;
    }

    case "content_block_stop": {
      const index = getEventIndex(parsed, eventType);
      const blockState = openContentBlocks.get(index);
      if (!blockState) {
        throw new Error(`orphan content_block_stop for index ${index}`);
      }

      if (blockState.type === "tool_use" && blockState.partialJson) {
        try {
          JSON.parse(blockState.partialJson);
        } catch {
          throw new Error(`incomplete tool_use partial_json for index ${index}`);
        }
      }

      openContentBlocks.delete(index);
      return;
    }

    default:
      return;
  }
}

function getOpenBlockError(openContentBlocks: Map<number, OpenContentBlockState>): Error | null {
  const openBlockContext = getOpenBlockContext(openContentBlocks);
  return openBlockContext ? createStreamTruncatedError(openBlockContext) : null;
}

function getMessageStopBlockError(openContentBlocks: Map<number, OpenContentBlockState>): Error | null {
  for (const [index, blockState] of openContentBlocks) {
    if (blockState.partialJson) {
      return new Error(`incomplete tool_use partial_json for index ${index}`);
    }
  }

  return null;
}

function normalizeChunk(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function toStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

/**
 * Parse one SSE event payload and return account-error details if present.
 */
export function getMidStreamAccountError(parsed: unknown): {
  reason: string;
  invalidateToken: boolean;
} | null {
  const p = parsed as Record<string, unknown> | null;
  if (!p || p.type !== "error" || !p.error) {
    return null;
  }

  const err = p.error as Record<string, unknown>;
  const errorBody = {
    error: {
      type: String(err.type || ""),
      message: String(err.message || ""),
    },
  };

  // Mid-stream errors do not include a reliable HTTP status. Use 400-style
  // body parsing to identify account-specific errors.
  if (!isAccountSpecificError(400, errorBody)) {
    return null;
  }

  const reason = parseRateLimitReason(400, errorBody);

  return {
    reason,
    invalidateToken: reason === "AUTH_FAILED",
  };
}

/**
 * Wrap a response body stream to strip mcp_ prefix from tool names,
 * extract token usage stats from SSE events, and detect mid-stream
 * account-specific errors.
 */
export function transformResponse(
  response: Response,
  onUsage?: ((stats: UsageStats) => void) | null,
  onAccountError?: ((details: { reason: string; invalidateToken: boolean }) => void) | null,
  onStreamError?: ((error: Error) => void) | null,
): Response {
  if (!response.body || !isEventStreamResponse(response)) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();

  const stats: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let sseBuffer = "";
  let accountErrorHandled = false;
  let hasSeenMessageStop = false;
  let hasSeenError = false;
  let lastEventType: string | null = null;
  const strictEventValidation = !onUsage && !onAccountError;
  const openContentBlocks = new Map<number, OpenContentBlockState>();

  function enqueueNormalizedEvent(controller: ReadableStreamDefaultController<Uint8Array>, eventBlock: string): void {
    const payload = getSSEDataPayload(eventBlock);
    if (!payload) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error("invalid SSE event: malformed JSON payload");
    }

    const eventType =
      getSSEEventType(eventBlock) ?? ((parsed as Record<string, unknown> | null)?.type as string | undefined);
    if (typeof eventType !== "string" || !eventType) {
      throw new Error("invalid SSE event: missing event type");
    }

    const parsedRecord = parsed as Record<string, unknown>;
    lastEventType = getEventLabel(parsedRecord, eventType);
    if (strictEventValidation) {
      validateEventState(parsedRecord, eventType, openContentBlocks);
    }
    stripMcpPrefixFromParsedEvent(parsedRecord);

    if (onUsage) {
      extractUsageFromSSEEvent(parsedRecord, stats);
    }

    if (onAccountError && !accountErrorHandled) {
      const details = getMidStreamAccountError(parsedRecord);
      if (details) {
        accountErrorHandled = true;
        onAccountError(details);
      }
    }

    if (eventType === "message_stop") {
      if (strictEventValidation) {
        const openBlockError = getMessageStopBlockError(openContentBlocks);
        if (openBlockError) {
          throw openBlockError;
        }

        openContentBlocks.clear();
      }

      hasSeenMessageStop = true;
    }

    if (eventType === "error") {
      hasSeenError = true;
    }

    controller.enqueue(encoder.encode(formatSSEEventBlock(eventType, parsedRecord, strictEventValidation)));

    if (eventType === "error" && strictEventValidation) {
      throw new Error(getErrorMessage(parsedRecord));
    }
  }

  function processBufferedEvents(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
    let emitted = false;

    while (true) {
      const boundary = sseBuffer.indexOf("\n\n");
      if (boundary === -1) {
        if (sseBuffer.length > MAX_UNTERMINATED_SSE_BUFFER) {
          throw new Error("unterminated SSE event buffer exceeded limit");
        }
        return emitted;
      }

      const eventBlock = sseBuffer.slice(0, boundary);
      sseBuffer = sseBuffer.slice(boundary + 2);

      if (!eventBlock.trim()) {
        continue;
      }

      enqueueNormalizedEvent(controller, eventBlock);
      emitted = true;
    }
  }

  async function failStream(controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): Promise<void> {
    const streamError = toStreamError(error);

    if (onStreamError) {
      try {
        onStreamError(streamError);
      } catch {}
    }

    try {
      await reader.cancel(streamError);
    } catch {}

    controller.error(streamError);
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const flushedText = decoder.decode();
            if (flushedText) {
              sseBuffer += normalizeChunk(flushedText);
              processBufferedEvents(controller);
            }

            if (sseBuffer.trim()) {
              if (strictEventValidation) {
                throw createStreamTruncatedError(getBufferedEventContext(sseBuffer, lastEventType));
              }

              enqueueNormalizedEvent(controller, sseBuffer);
              sseBuffer = "";
            }

            if (strictEventValidation) {
              const openBlockError = getOpenBlockError(openContentBlocks);
              if (openBlockError) {
                throw openBlockError;
              }

              if (!hasSeenMessageStop && !hasSeenError) {
                throw createStreamTruncatedError({
                  inFlightEvent: lastEventType ?? undefined,
                  lastEventType: lastEventType ?? undefined,
                });
              }
            }

            if (onUsage && hasRecordedUsage(stats)) {
              onUsage(stats);
            }

            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          if (!text) {
            continue;
          }

          sseBuffer += normalizeChunk(text);
          if (processBufferedEvents(controller)) {
            return;
          }
        }
      } catch (error) {
        await failStream(controller, error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Check whether a response is an SSE event stream.
 */
export function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/event-stream");
}
