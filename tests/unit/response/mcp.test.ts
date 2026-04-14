import { describe, expect, it } from "vitest";

import {
    contentBlockStopEvent,
    encodeSSEEvent,
    encodeSSEStream,
    messageStartEvent,
    messageStopEvent,
} from "../../helpers/sse.js";
import {
    stripMcpPrefixFromJsonBody,
    stripMcpPrefixFromParsedEvent,
    stripMcpPrefixFromSSE,
} from "../../../src/response/mcp.js";

function createServerToolUseBlock(name: string, input: Record<string, unknown> = { query: "weather" }) {
    return {
        type: "server_tool_use",
        id: "srvtoolu_123",
        name,
        input,
    };
}

function createToolReferenceBlock(toolName: string) {
    return {
        type: "tool_reference",
        tool_name: toolName,
    };
}

function createToolSearchToolResultBlock(toolNames: string[]) {
    return {
        type: "tool_search_tool_result",
        tool_use_id: "srvtoolu_123",
        content: {
            type: "tool_search_tool_search_result",
            tool_references: toolNames.map(createToolReferenceBlock),
        },
    };
}

function createToolUseBlock(name: string, input: Record<string, unknown> = { path: "/tmp/demo.txt" }) {
    return {
        type: "tool_use",
        id: "toolu_123",
        name,
        input,
    };
}

function encodeContentBlockStart(block: unknown, index = 0): string {
    return encodeSSEEvent({
        data: JSON.stringify({
            type: "content_block_start",
            index,
            content_block: block,
        }),
    });
}

describe("stripMcpPrefixFromParsedEvent RED - tool search blocks", () => {
    it("strips mcp_ prefixes from server_tool_use blocks", () => {
        const parsed = {
            type: "content_block_start",
            index: 0,
            content_block: createServerToolUseBlock("mcp_tool_search_tool_regex"),
        };

        expect(stripMcpPrefixFromParsedEvent(parsed)).toBe(true);
        expect(parsed).toMatchObject({
            content_block: {
                type: "server_tool_use",
                name: "tool_search_tool_regex",
            },
        });
    });

    it("strips mcp_ prefixes from tool_reference blocks nested inside tool_search_tool_result blocks", () => {
        const parsed = {
            type: "content_block_start",
            index: 1,
            content_block: createToolSearchToolResultBlock(["mcp_read_file", "mcp_list_dir"]),
        };

        expect(stripMcpPrefixFromParsedEvent(parsed)).toBe(true);
        expect(parsed).toMatchObject({
            content_block: {
                type: "tool_search_tool_result",
                content: {
                    tool_references: [
                        { type: "tool_reference", tool_name: "read_file" },
                        { type: "tool_reference", tool_name: "list_dir" },
                    ],
                },
            },
        });
    });

    it("strips mcp_ prefixes from standalone tool_reference blocks while preserving existing tool_use handling", () => {
        const parsed = {
            content: [createToolReferenceBlock("mcp_search_files"), createToolUseBlock("mcp_read_file")],
        };

        expect(stripMcpPrefixFromParsedEvent(parsed)).toBe(true);
        expect(parsed).toMatchObject({
            content: [
                { type: "tool_reference", tool_name: "search_files" },
                { type: "tool_use", name: "read_file" },
            ],
        });
    });

    it("ignores empty tool_search_tool_result blocks that do not include tool references", () => {
        const parsed = {
            type: "content_block_start",
            index: 2,
            content_block: {
                type: "tool_search_tool_result",
                tool_use_id: "srvtoolu_456",
                content: {
                    type: "tool_search_tool_search_result",
                    tool_references: [],
                },
            },
        };

        expect(stripMcpPrefixFromParsedEvent(parsed)).toBe(false);
        expect(parsed).toMatchObject({
            content_block: {
                content: {
                    tool_references: [],
                },
            },
        });
    });
});

describe("stripMcpPrefixFromJsonBody RED - tool search blocks", () => {
    it("strips mcp_ prefixes from server_tool_use, tool_search_tool_result, tool_reference, and tool_use blocks", () => {
        const body = JSON.stringify({
            content: [
                createServerToolUseBlock("mcp_tool_search_tool_bm25"),
                createToolSearchToolResultBlock(["mcp_search_files", "mcp_read_file"]),
                createToolReferenceBlock("mcp_list_dir"),
                createToolUseBlock("mcp_read_file"),
            ],
            message: {
                content: [createToolReferenceBlock("mcp_get_weather")],
            },
            messages: [
                {
                    content: [
                        createServerToolUseBlock("mcp_tool_search_tool_regex"),
                        createToolSearchToolResultBlock(["mcp_bash_exec"]),
                    ],
                },
            ],
        });

        const transformed = JSON.parse(stripMcpPrefixFromJsonBody(body));

        expect(transformed).toMatchObject({
            content: [
                { type: "server_tool_use", name: "tool_search_tool_bm25" },
                {
                    type: "tool_search_tool_result",
                    content: {
                        tool_references: [
                            { type: "tool_reference", tool_name: "search_files" },
                            { type: "tool_reference", tool_name: "read_file" },
                        ],
                    },
                },
                { type: "tool_reference", tool_name: "list_dir" },
                { type: "tool_use", name: "read_file" },
            ],
            message: {
                content: [{ type: "tool_reference", tool_name: "get_weather" }],
            },
            messages: [
                {
                    content: [
                        { type: "server_tool_use", name: "tool_search_tool_regex" },
                        {
                            type: "tool_search_tool_result",
                            content: {
                                tool_references: [{ type: "tool_reference", tool_name: "bash_exec" }],
                            },
                        },
                    ],
                },
            ],
        });
    });
});

describe("stripMcpPrefixFromSSE RED - tool search streams", () => {
    it("rewrites mixed SSE streams that combine tool search blocks with regular tool_use blocks", () => {
        const stream = [
            encodeSSEStream([messageStartEvent()]),
            encodeContentBlockStart(createServerToolUseBlock("mcp_tool_search_tool_regex"), 0),
            encodeSSEStream([contentBlockStopEvent(0)]),
            encodeContentBlockStart(createToolSearchToolResultBlock(["mcp_read_file", "mcp_list_dir"]), 1),
            encodeSSEStream([contentBlockStopEvent(1)]),
            encodeContentBlockStart(createToolUseBlock("mcp_read_file"), 2),
            encodeSSEStream([contentBlockStopEvent(2), messageStopEvent()]),
        ].join("");

        const rewritten = stripMcpPrefixFromSSE(stream);

        expect(rewritten).toContain('"type":"server_tool_use"');
        expect(rewritten).toContain('"name":"tool_search_tool_regex"');
        expect(rewritten).toContain('"type":"tool_search_tool_result"');
        expect(rewritten).toContain('"tool_name":"read_file"');
        expect(rewritten).toContain('"tool_name":"list_dir"');
        expect(rewritten).toContain('"type":"tool_use"');
        expect(rewritten).toContain('"name":"read_file"');
        expect(rewritten).not.toContain("mcp_read_file");
        expect(rewritten).not.toContain("mcp_tool_search_tool_regex");
    });

    it("preserves malformed JSON events while still rewriting following tool search blocks", () => {
        const malformed = 'data: {"type":"content_block_start","index":0,\n\n';
        const stream = [
            malformed,
            encodeContentBlockStart(createToolSearchToolResultBlock(["mcp_search_files"]), 1),
            encodeContentBlockStart(createToolUseBlock("mcp_read_file"), 2),
        ].join("");

        const rewritten = stripMcpPrefixFromSSE(stream);

        expect(rewritten).toContain(malformed.trimEnd());
        expect(rewritten).toContain('"type":"tool_search_tool_result"');
        expect(rewritten).toContain('"tool_name":"search_files"');
        expect(rewritten).toContain('"name":"read_file"');
        expect(rewritten).not.toContain("mcp_search_files");
    });
});
