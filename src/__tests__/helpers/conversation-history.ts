/**
 * Factory functions for creating conversation state in tests.
 *
 * Provides utilities for building Anthropic Messages API compatible
 * conversation objects, messages, tool_use blocks, and tool_result blocks.
 *
 * @example
 * ```ts
 * const conversation = makeConversation({
 *   messages: [
 *     makeMessage({ role: 'user', content: 'Hello' }),
 *     makeMessage({
 *       role: 'assistant',
 *       content: [makeToolUse({ name: 'read_file', input: { path: 'test.txt' } })]
 *     }),
 *     makeMessage({
 *       role: 'user',
 *       content: [makeToolResult({ toolUseId: 'tu_123', content: 'file contents' })]
 *     })
 *   ]
 * });
 * ```
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant";

export interface TextBlock {
    type: "text";
    text: string;
}

export interface ToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface ToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | Array<TextBlock | ImageBlock>;
    is_error?: boolean;
}

export interface ImageBlock {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}

export type MessageContent = string | Array<TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock>;

export interface Message {
    role: MessageRole;
    content: MessageContent;
}

export interface Conversation {
    messages: Message[];
    metadata?: Record<string, unknown>;
}

export interface ConversationFactory {
    /** Generate unique IDs (default: true) */
    generateIds?: boolean;
    /** Default prefix for generated IDs */
    idPrefix?: string;
}

export interface MakeConversationOptions extends ConversationFactory {
    /** Pre-populated messages array */
    messages?: Message[];
    /** Optional conversation metadata */
    metadata?: Record<string, unknown>;
}

export interface MakeMessageOptions {
    /** Message role (user or assistant) */
    role?: MessageRole;
    /** Message content - string or content blocks array */
    content?: MessageContent;
}

export interface MakeToolUseOptions {
    /** Unique tool use ID (auto-generated if not provided) */
    id?: string;
    /** Tool name */
    name?: string;
    /** Tool input parameters */
    input?: Record<string, unknown>;
}

export interface MakeToolResultOptions {
    /** ID of the tool_use this result corresponds to */
    toolUseId?: string;
    /** Result content - string or content blocks */
    content?: string | Array<TextBlock | ImageBlock>;
    /** Whether this result represents an error */
    isError?: boolean;
}

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

let idCounter = 0;

/**
 * Generate a unique tool use ID.
 *
 * @param prefix - ID prefix (default: "tu")
 * @returns Unique ID string
 */
export function generateToolUseId(prefix = "tu"): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}_${++idCounter}`;
}

/**
 * Reset the ID counter for deterministic tests.
 */
export function resetIdCounter(): void {
    idCounter = 0;
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a conversation object with messages array.
 *
 * @param opts - Conversation options
 * @returns Conversation object
 *
 * @example
 * ```ts
 * const conversation = makeConversation({
 *   messages: [makeMessage({ role: 'user', content: 'Hello' })],
 *   metadata: { sessionId: 'abc123' }
 * });
 * ```
 */
export function makeConversation(opts: MakeConversationOptions = {}): Conversation {
    return {
        messages: opts.messages ?? [],
        metadata: opts.metadata,
    };
}

/**
 * Create a message with role and content.
 *
 * @param opts - Message options
 * @returns Message object
 *
 * @example
 * ```ts
 * const msg = makeMessage({ role: 'user', content: 'Hello Claude' });
 * const assistantMsg = makeMessage({
 *   role: 'assistant',
 *   content: [{ type: 'text', text: 'Hello!' }]
 * });
 * ```
 */
export function makeMessage(opts: MakeMessageOptions = {}): Message {
    const role = opts.role ?? "user";
    const content = opts.content ?? "";

    return { role, content };
}

/**
 * Create a text content block.
 *
 * @param text - Text content
 * @returns TextBlock object
 */
export function makeTextBlock(text: string): TextBlock {
    return { type: "text", text };
}

/**
 * Create a tool_use block with id, name, and input.
 *
 * @param opts - Tool use options
 * @returns ToolUseBlock object
 *
 * @example
 * ```ts
 * const toolUse = makeToolUse({
 *   name: 'read_file',
 *   input: { path: 'src/index.ts' }
 * });
 * ```
 */
export function makeToolUse(opts: MakeToolUseOptions = {}): ToolUseBlock {
    return {
        type: "tool_use",
        id: opts.id ?? generateToolUseId(),
        name: opts.name ?? "unnamed_tool",
        input: opts.input ?? {},
    };
}

/**
 * Create a tool_result block with tool_use_id and content.
 *
 * @param opts - Tool result options
 * @returns ToolResultBlock object
 *
 * @example
 * ```ts
 * const toolResult = makeToolResult({
 *   toolUseId: 'tu_abc123',
 *   content: 'File contents here'
 * });
 * ```
 */
export function makeToolResult(opts: MakeToolResultOptions = {}): ToolResultBlock {
    return {
        type: "tool_result",
        tool_use_id: opts.toolUseId ?? generateToolUseId("tr"),
        content: opts.content ?? "",
        is_error: opts.isError ?? false,
    };
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate that a tool_use and tool_result pair match.
 *
 * @param toolUse - The tool_use block
 * @param toolResult - The tool_result block
 * @returns True if the pair is valid
 */
export function validateToolPair(toolUse: ToolUseBlock, toolResult: ToolResultBlock): boolean {
    return toolUse.id === toolResult.tool_use_id;
}

/**
 * Find the tool_result corresponding to a tool_use in a message array.
 *
 * @param messages - Array of messages to search
 * @param toolUseId - The tool_use ID to find the result for
 * @returns The matching ToolResultBlock or undefined
 */
export function findToolResult(messages: Message[], toolUseId: string): ToolResultBlock | undefined {
    for (const message of messages) {
        if (typeof message.content === "string") continue;

        for (const block of message.content) {
            if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
                return block;
            }
        }
    }
    return undefined;
}

/**
 * Check if all tool_use blocks in a conversation have matching tool_results.
 *
 * @param conversation - The conversation to validate
 * @returns Object with validation results
 */
export function validateConversationTools(conversation: Conversation): {
    valid: boolean;
    unmatchedToolUses: ToolUseBlock[];
    unmatchedToolResults: ToolResultBlock[];
} {
    const toolUses: ToolUseBlock[] = [];
    const toolResults: ToolResultBlock[] = [];

    // Collect all tool_use and tool_result blocks
    for (const message of conversation.messages) {
        if (typeof message.content === "string") continue;

        for (const block of message.content) {
            if (block.type === "tool_use") {
                toolUses.push(block);
            } else if (block.type === "tool_result") {
                toolResults.push(block);
            }
        }
    }

    const unmatchedToolUses = toolUses.filter((tu) => !toolResults.some((tr) => tr.tool_use_id === tu.id));

    const unmatchedToolResults = toolResults.filter((tr) => !toolUses.some((tu) => tu.id === tr.tool_use_id));

    return {
        valid: unmatchedToolUses.length === 0 && unmatchedToolResults.length === 0,
        unmatchedToolUses,
        unmatchedToolResults,
    };
}

// ---------------------------------------------------------------------------
// Convenience Builders
// ---------------------------------------------------------------------------

/**
 * Create a complete tool call exchange: assistant tool_use + user tool_result.
 *
 * @param toolName - Name of the tool
 * @param toolInput - Tool input parameters
 * @param resultContent - Result content string
 * @returns Array of [toolUse, toolResult] pair
 *
 * @example
 * ```ts
 * const [toolUse, toolResult] = makeToolExchange(
 *   'read_file',
 *   { path: 'test.txt' },
 *   'file contents'
 * );
 * ```
 */
export function makeToolExchange(
    toolName: string,
    toolInput: Record<string, unknown>,
    resultContent: string,
): [ToolUseBlock, ToolResultBlock] {
    const toolUse = makeToolUse({ name: toolName, input: toolInput });
    const toolResult = makeToolResult({ toolUseId: toolUse.id, content: resultContent });
    return [toolUse, toolResult];
}

/**
 * Create a conversation with a complete tool call flow.
 *
 * @param userPrompt - Initial user message
 * @param toolName - Tool to call
 * @param toolInput - Tool input
 * @param toolOutput - Tool output
 * @returns Conversation with complete message flow
 *
 * @example
 * ```ts
 * const conv = makeToolConversation(
 *   'Read the file',
 *   'read_file',
 *   { path: 'test.txt' },
 *   'file contents'
 * );
 * ```
 */
export function makeToolConversation(
    userPrompt: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput: string,
): Conversation {
    const [toolUse, toolResult] = makeToolExchange(toolName, toolInput, toolOutput);

    return makeConversation({
        messages: [
            makeMessage({ role: "user", content: userPrompt }),
            makeMessage({ role: "assistant", content: [toolUse] }),
            makeMessage({ role: "user", content: [toolResult] }),
        ],
    });
}
