// ---------------------------------------------------------------------------
// Body transformation tests - TDD RED phase
// Tests for tool name drift defense and body handling edge cases
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { resolveSignatureProfile, TOOL_SEARCH_SIGNATURE_PROFILE_ID } from "../../../src/profiles/index.js";
import {
    transformRequestBody,
    validateBodyType,
    cloneBodyForRetry,
    detectDoublePrefix,
    extractToolNamesFromBody,
    isTitleGeneratorRequestBody,
} from "../../../src/request/body.js";
import type { RuntimeContext, SignatureConfig } from "../../../src/types.js";

const mockRuntime: RuntimeContext = {
    persistentUserId: "user-123",
    accountId: "acc-456",
    sessionId: "sess-789",
};

const mockSignature: SignatureConfig = {
    enabled: true,
    claudeCliVersion: "0.2.45",
    promptCompactionMode: "minimal",
};

describe("transformRequestBody - type validation", () => {
    it("should reject undefined body without error", () => {
        const result = transformRequestBody(undefined, mockSignature, mockRuntime);
        expect(result).toBeUndefined();
    });

    it("should reject null body without error", () => {
        const result = transformRequestBody(null as unknown as string, mockSignature, mockRuntime);
        expect(result).toBeNull();
    });

    it("should reject non-string body with clear error", () => {
        const invalidBodies = [123, {}, [], true, () => {}];

        for (const body of invalidBodies) {
            expect(() => transformRequestBody(body as unknown as string, mockSignature, mockRuntime)).toThrow(
                /opencode-anthropic-auth: expected string body, got /,
            );
        }
    });

    it("should validate body type at runtime with descriptive error", () => {
        const debugLog = vi.fn();
        const body = { not: "a string" };

        expect(() =>
            transformRequestBody(body as unknown as string, mockSignature, mockRuntime, true, debugLog),
        ).toThrow(
            "opencode-anthropic-auth: expected string body, got object. This plugin does not support stream bodies. Please file a bug with the OpenCode version.",
        );
    });
});

describe("transformRequestBody - double-prefix defense", () => {
    it("should detect and reject double-prefixed tool names (mcp_mcp_)", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "test" }],
            tools: [
                { name: "mcp_mcp_read_file", description: "Read a file" },
                { name: "mcp_mcp_write_file", description: "Write a file" },
            ],
        });

        expect(() => transformRequestBody(body, mockSignature, mockRuntime)).toThrow(
            /Double tool prefix detected: mcp_mcp_/,
        );
    });

    it("should detect double-prefix in tool_use blocks", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "tool_use", name: "mcp_mcp_read_file", input: {} }],
                },
            ],
        });

        expect(() => transformRequestBody(body, mockSignature, mockRuntime)).toThrow(
            /Double tool prefix detected in tool_use block/,
        );
    });

    it("should double-prefix literal mcp_ tool definitions to preserve round-trip names", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "test" }],
            tools: [{ name: "mcp_read_file", description: "Read a file" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.tools[0].name).toBe("ReadFile");
    });

    it("should keep literal mcp_ tool definitions round-trip safe", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            tools: [
                { name: "mcp_server1__tool1", description: "Tool 1" },
                { name: "mcp_server2__tool2", description: "Tool 2" },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.tools[0].name).toBe("Server1Tool1");
        expect(parsed.tools[1].name).toBe("Server2Tool2");
    });
});

describe("transformRequestBody - body cloning for retries", () => {
    it("should clone body before transformation to preserve original", () => {
        const originalBody = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "test" }],
            tools: [{ name: "read_file", description: "Read a file" }],
        });

        const result1 = transformRequestBody(originalBody, mockSignature, mockRuntime);
        const result2 = transformRequestBody(originalBody, mockSignature, mockRuntime);
        expect(result1).toBe(result2);

        const parsedOriginal = JSON.parse(originalBody);
        expect(parsedOriginal.tools[0].name).toBe("read_file");
    });

    it("should return empty bodies unchanged", () => {
        expect(transformRequestBody("", mockSignature, mockRuntime)).toBe("");
    });

    it("should handle retry with same body multiple times", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "test" }],
        });

        const result1 = transformRequestBody(body, mockSignature, mockRuntime);
        expect(result1).toBeDefined();

        const result2 = transformRequestBody(body, mockSignature, mockRuntime);
        expect(result2).toBeDefined();
        expect(result1).toBe(result2);
    });
});

describe("transformRequestBody - tool name handling", () => {
    it("should add mcp_ prefix to unprefixed tool names", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            tools: [
                { name: "read_file", description: "Read a file" },
                { name: "write_file", description: "Write a file" },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.tools[0].name).toBe("ReadFile");
        expect(parsed.tools[1].name).toBe("WriteFile");
    });

    it("should handle historical tool_use.name with prefix correctly", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "tool_use", name: "mcp_read_file", input: { path: "/test" } }],
                },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        // Should preserve the prefixed name in historical context
        expect(parsed.messages[0].content[0].name).toBe("ReadFile");
    });

    it("should handle mixed prefixed and unprefixed tools", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            tools: [
                { name: "read_file", description: "Read" },
                { name: "mcp_existing_tool", description: "Existing" },
                { name: "write_file", description: "Write" },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.tools[0].name).toBe("ReadFile");
        expect(parsed.tools[1].name).toBe("ExistingTool");
        expect(parsed.tools[2].name).toBe("WriteFile");
    });

    it("adds defer_loading and injects the tool search server tool when the tool-search profile is enabled", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            tools: [
                { name: "read_file", description: "Read a file" },
                { name: "write_file", description: "Write a file" },
            ],
        });

        const result = transformRequestBody(
            body,
            {
                ...mockSignature,
                profile: resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID),
            },
            mockRuntime,
        );
        const parsed = JSON.parse(result!);

        expect(parsed.tools).toEqual([
            {
                type: "tool_search_tool_regex_20251119",
                name: "tool_search_tool_regex",
            },
            {
                name: "ReadFile",
                description: "Read a file",
                defer_loading: true,
            },
            {
                name: "WriteFile",
                description: "Write a file",
                defer_loading: true,
            },
        ]);
    });

    it("keeps haiku requests on the standard tool path even with the tool-search profile", () => {
        const body = JSON.stringify({
            model: "claude-haiku-4-5",
            tools: [{ name: "read_file", description: "Read a file" }],
        });

        const result = transformRequestBody(
            body,
            {
                ...mockSignature,
                profile: resolveSignatureProfile(TOOL_SEARCH_SIGNATURE_PROFILE_ID),
            },
            mockRuntime,
        );
        const parsed = JSON.parse(result!);

        expect(parsed.tools).toEqual([{ name: "ReadFile", description: "Read a file" }]);
    });
});

describe("transformRequestBody - structure preservation", () => {
    it("should preserve all non-tool fields during transformation", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 4096,
            temperature: 0.7,
            system: [{ type: "text", text: "You are helpful" }],
            messages: [
                { role: "user", content: "Hello" },
                { role: "assistant", content: "Hi there" },
            ],
            metadata: { user_id: "test-user" },
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.model).toBe("claude-sonnet-4-20250514");
        expect(parsed.max_tokens).toBe(4096);
        expect(parsed.temperature).toBe(0.7);
        const systemTexts = parsed.system.map((block: { text?: string }) => block.text ?? "");
        expect(systemTexts.some((text: string) => text === "You are helpful")).toBe(true);
        expect(parsed.messages).toHaveLength(2);
        expect(parsed.messages[0].content).toBe("Hello");
        expect(parsed.metadata.user_id).toContain('"device_id":"user-123"');
        expect(parsed.metadata.user_id).toContain('"account_uuid":"acc-456"');
        expect(parsed.metadata.user_id).toContain('"session_id":"sess-789"');
    });

    it("preserves text blocks when a matching tool_use/tool_result pair exists", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                {
                    role: "assistant",
                    content: [
                        { type: "text", text: "running" },
                        { type: "tool_use", id: "tool_123", name: "Bash", input: {} },
                    ],
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Process this" },
                        {
                            type: "tool_result",
                            tool_use_id: "tool_123",
                            content: "some result",
                        },
                    ],
                },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.messages).toHaveLength(2);
        expect(parsed.messages[1].content).toHaveLength(2);
        expect(parsed.messages[1].content[0].type).toBe("text");
        expect(parsed.messages[1].content[1].type).toBe("tool_result");
    });

    it("removes orphaned tool_result blocks whose tool_use is missing", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Process this" },
                        {
                            type: "tool_result",
                            tool_use_id: "tool_orphan",
                            content: "stale result",
                        },
                    ],
                },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.messages[0].content).toHaveLength(1);
        expect(parsed.messages[0].content[0].type).toBe("text");
    });

    it("should preserve nested structures in tool input", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            name: "complex_tool",
                            input: {
                                nested: {
                                    deep: {
                                        value: "test",
                                        array: [1, 2, 3],
                                    },
                                },
                            },
                        },
                    ],
                },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        const toolUse = parsed.messages[0].content[0];
        expect(toolUse.input.nested.deep.value).toBe("test");
        expect(toolUse.input.nested.deep.array).toEqual([1, 2, 3]);
    });
});

describe("transformRequestBody - verified body shaping", () => {
    it("rewrites adaptive-thinking models to thinking.type=adaptive with output_config.effort", () => {
        const body = JSON.stringify({
            model: "claude-opus-4-7",
            messages: [{ role: "user", content: "hi" }],
            thinking: { type: "enabled", budget_tokens: 8000 },
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.thinking).toEqual({ type: "adaptive" });
        expect(parsed.output_config).toEqual({ effort: "medium" });
        expect(parsed.context_management).toEqual({
            edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        });
        expect(Object.prototype.hasOwnProperty.call(parsed, "temperature")).toBe(false);
    });

    it("preserves existing output_config fields while injecting adaptive effort", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-7",
            messages: [{ role: "user", content: "hi" }],
            thinking: { type: "enabled", effort: "max" },
            output_config: { format: { type: "json_schema" }, existing: true },
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.thinking).toEqual({ type: "adaptive" });
        expect(parsed.output_config).toEqual({
            format: { type: "json_schema" },
            existing: true,
            effort: "max",
        });
    });

    it("forces Claude title generation requests to stream with 32000 max tokens", () => {
        const body = JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            stream: false,
            messages: [{ role: "user", content: [{ type: "text", text: "Hows going" }] }],
            system: [
                {
                    type: "text",
                    text: 'Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. Return JSON with a single "title" field.',
                },
            ],
            output_config: {
                format: {
                    type: "json_schema",
                    schema: {
                        type: "object",
                        properties: { title: { type: "string" } },
                        required: ["title"],
                        additionalProperties: false,
                    },
                },
            },
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.max_tokens).toBe(32000);
        expect(parsed.stream).toBe(true);
    });

    it("detects title-generator requests from raw body", () => {
        const body = JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            system: [
                {
                    type: "text",
                    text: 'Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. Return JSON with a single "title" field.',
                },
            ],
            output_config: { format: { type: "json_schema" } },
        });

        expect(isTitleGeneratorRequestBody(body)).toBe(true);
    });

    it("forces quota probe requests to max_tokens 1 and omits stream", () => {
        const body = JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1024,
            stream: false,
            messages: [{ role: "user", content: "quota" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.max_tokens).toBe(1);
        expect(Object.prototype.hasOwnProperty.call(parsed, "stream")).toBe(false);
    });

    it("forces adaptive Opus tool requests to stream with 64000 max tokens", () => {
        const body = JSON.stringify({
            model: "claude-opus-4-6",
            max_tokens: 1024,
            stream: false,
            messages: [{ role: "user", content: "hi" }],
            tools: [{ name: "read_file", description: "Read a file" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime);
        const parsed = JSON.parse(result!);

        expect(parsed.max_tokens).toBe(64000);
        expect(parsed.stream).toBe(true);
        expect(parsed.tools[0].name).toBe("ReadFile");
    });
});

describe("validateBodyType", () => {
    it("should return true for valid string body", () => {
        expect(validateBodyType('{"test": true}')).toBe(true);
    });

    it("should return false for undefined", () => {
        expect(validateBodyType(undefined)).toBe(false);
    });

    it("should return false for null", () => {
        expect(validateBodyType(null as unknown as string)).toBe(false);
    });

    it("should return false for non-string types", () => {
        expect(validateBodyType(123 as unknown as string)).toBe(false);
        expect(validateBodyType({} as unknown as string)).toBe(false);
        expect(validateBodyType([] as unknown as string)).toBe(false);
    });

    it("should throw with descriptive message when throwOnInvalid is true", () => {
        expect(() => validateBodyType(123 as unknown as string, true)).toThrow(
            "opencode-anthropic-auth: expected string body, got number. This plugin does not support stream bodies. Please file a bug with the OpenCode version.",
        );
    });
});

describe("cloneBodyForRetry", () => {
    it("should return the same string value for retry", () => {
        const original = '{"test": true}';
        const cloned = cloneBodyForRetry(original);

        expect(cloned).toBe(original);
    });

    it("should allow empty string bodies", () => {
        expect(() => cloneBodyForRetry("")).not.toThrow();
    });

    it("should handle empty but valid body", () => {
        expect(() => cloneBodyForRetry("{}")).not.toThrow();
    });
});

describe("detectDoublePrefix", () => {
    it("should detect mcp_mcp_ prefix", () => {
        expect(detectDoublePrefix("mcp_mcp_read_file")).toBe(true);
    });

    it("should not detect single mcp_ prefix", () => {
        expect(detectDoublePrefix("mcp_read_file")).toBe(false);
    });

    it("should not detect unprefixed names", () => {
        expect(detectDoublePrefix("read_file")).toBe(false);
    });

    it("should detect triple prefix", () => {
        expect(detectDoublePrefix("mcp_mcp_mcp_read_file")).toBe(true);
    });
});

describe("extractToolNamesFromBody", () => {
    it("should extract tool names from tools array", () => {
        const body = JSON.stringify({
            tools: [{ name: "tool1" }, { name: "tool2" }],
        });

        const names = extractToolNamesFromBody(body);
        expect(names).toEqual(["tool1", "tool2"]);
    });

    it("should extract tool names from tool_use blocks", () => {
        const body = JSON.stringify({
            messages: [
                {
                    content: [
                        { type: "tool_use", name: "tool1" },
                        { type: "text", text: "hello" },
                        { type: "tool_use", name: "tool2" },
                    ],
                },
            ],
        });

        const names = extractToolNamesFromBody(body);
        expect(names).toEqual(["tool1", "tool2"]);
    });

    it("should return empty array for body without tools", () => {
        const body = JSON.stringify({ messages: [] });
        const names = extractToolNamesFromBody(body);
        expect(names).toEqual([]);
    });

    it("should throw for invalid JSON", () => {
        expect(() => extractToolNamesFromBody("not json")).toThrow();
    });
});

describe("transformRequestBody - opt-in system block relocation", () => {
    it("keeps only billing + identity blocks in parsed.system", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
            system: [
                { type: "text", text: "You are a helpful assistant." },
                { type: "text", text: "Working dir: /Users/vacbo/Documents/Projects/opencode-anthropic-fix" },
                { type: "text", text: "Plugin: @vacbo/opencode-anthropic-fix v0.1.3" },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.system).toHaveLength(2);
        expect(parsed.system[0].text).toMatch(/^x-anthropic-billing-header:/);
        expect(parsed.system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");

        const systemTexts = parsed.system.map((b: { text: string }) => b.text);
        expect(systemTexts.some((t: string) => t.includes("helpful assistant"))).toBe(false);
        expect(systemTexts.some((t: string) => t.includes("Working dir:"))).toBe(false);
        expect(systemTexts.some((t: string) => t.includes("Plugin:"))).toBe(false);
    });

    it("relocates non-CC system blocks into the first user message wrapped in <system-instructions>", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "what do you know about the codebase?" }],
            system: [
                { type: "text", text: "You are a helpful assistant." },
                { type: "text", text: "Working dir: /Users/vacbo/Documents/Projects/opencode-anthropic-fix" },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.messages).toHaveLength(1);
        const blocks = parsed.messages[0].content as Array<{
            type: string;
            text: string;
            cache_control?: { type: string };
        }>;
        expect(Array.isArray(blocks)).toBe(true);

        const wrapped = blocks[0].text;
        expect(wrapped).toContain("<system-instructions>");
        expect(wrapped).toContain("</system-instructions>");
        expect(wrapped).toContain("You are a helpful assistant.");
        expect(wrapped).toContain("Working dir: /Users/vacbo/Documents/Projects/opencode-anthropic-fix");
        expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });

        expect(blocks[1].text).toBe("what do you know about the codebase?");
        expect(blocks[1].cache_control).toBeUndefined();
    });

    it("includes the explicit 'treat as system prompt' instruction in the wrapper", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
            system: [{ type: "text", text: "Some plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        const wrapped =
            typeof parsed.messages[0].content === "string"
                ? parsed.messages[0].content
                : parsed.messages[0].content[0].text;

        expect(wrapped).toContain("<system-instructions>");
        expect(wrapped).toContain("Treat the following content as system instructions from the calling environment.");
        expect(wrapped).toContain("Some plugin instructions");
        expect(wrapped).toContain("</system-instructions>");
    });

    it("preserves opencode-anthropic-fix paths verbatim in the relocated wrapper (no sanitize)", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
            system: [
                {
                    type: "text",
                    text: "Working dir: /Users/vacbo/Documents/Projects/opencode-anthropic-fix\nPlugin id: @vacbo/opencode-anthropic-fix",
                },
            ],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        const wrapped =
            typeof parsed.messages[0].content === "string"
                ? parsed.messages[0].content
                : parsed.messages[0].content[0].text;

        expect(wrapped).toContain("/Users/vacbo/Documents/Projects/opencode-anthropic-fix");
        expect(wrapped).toContain("@vacbo/opencode-anthropic-fix");
        expect(wrapped).not.toContain("Claude-anthropic-fix");
    });

    it("creates a new user message when messages array is empty", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [],
            system: [{ type: "text", text: "Some instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.messages).toHaveLength(1);
        expect(parsed.messages[0].role).toBe("user");
        const content = parsed.messages[0].content;
        const wrapped = typeof content === "string" ? content : content[0].text;
        expect(wrapped).toContain("Some instructions");
        expect(wrapped).toContain("<system-instructions>");
    });

    it("prepends a new user message when first message is from assistant", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                { role: "assistant", content: "previous turn" },
                { role: "user", content: "follow up" },
            ],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.messages).toHaveLength(3);
        expect(parsed.messages[0].role).toBe("user");
        const wrapped =
            typeof parsed.messages[0].content === "string"
                ? parsed.messages[0].content
                : parsed.messages[0].content[0].text;
        expect(wrapped).toContain("<system-instructions>");
        expect(wrapped).toContain("Plugin instructions");
        // Original turns survive in order.
        expect(parsed.messages[1].role).toBe("assistant");
        expect(parsed.messages[1].content).toBe("previous turn");
        expect(parsed.messages[2].role).toBe("user");
        expect(parsed.messages[2].content).toBe("follow up");
    });

    it("merges relocated wrapper into the first user message when content is a string", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "the original user request" }],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.messages).toHaveLength(1);
        expect(Array.isArray(parsed.messages[0].content)).toBe(true);
        const blocks = parsed.messages[0].content as Array<{
            type: string;
            text: string;
            cache_control?: { type: string };
        }>;
        expect(blocks).toHaveLength(2);
        expect(blocks[0].text).toContain("<system-instructions>");
        expect(blocks[0].text).toContain("Plugin instructions");
        expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
        expect(blocks[1].text).toBe("the original user request");
        expect(blocks[1].cache_control).toBeUndefined();
    });

    it("merges relocated wrapper into the first user message when content is an array", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "structured user turn" }],
                },
            ],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.messages).toHaveLength(1);
        expect(Array.isArray(parsed.messages[0].content)).toBe(true);
        const blocks = parsed.messages[0].content as Array<{
            type: string;
            text: string;
            cache_control?: { type: string };
        }>;
        expect(blocks[0].type).toBe("text");
        expect(blocks[0].text).toContain("<system-instructions>");
        expect(blocks[0].text).toContain("Plugin instructions");
        expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
        expect(blocks[1].text).toBe("structured user turn");
        expect(blocks[1].cache_control).toBeUndefined();
    });

    it("relocates third-party prompt blocks by default", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        const systemTexts = parsed.system.map((block: { text: string }) => block.text);
        expect(systemTexts[0]).toMatch(/^x-anthropic-billing-header:/);
        expect(systemTexts[1]).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
        expect(systemTexts).not.toContain("Plugin instructions");
        const content = parsed.messages[0].content as Array<{
            text: string;
            cache_control?: { type: string; ttl?: string };
        }>;
        expect(content[0].text).toContain("<system-instructions>");
        expect(content[0].text).toContain("Plugin instructions");
        expect(content[1].text).toBe("hi");
        expect(content[0].cache_control).toEqual({ type: "ephemeral" });
        expect(content[1].cache_control).toBeUndefined();
    });

    it("keeps cache_control blocks within Anthropic's four-block limit when upstream history already uses two", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [
                { role: "user", content: "latest user turn" },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "cached assistant context", cache_control: { type: "ephemeral" } }],
                },
                {
                    role: "user",
                    content: [{ type: "text", text: "cached user context", cache_control: { type: "ephemeral" } }],
                },
            ],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        const cacheControlledBlocks = [
            ...(parsed.system as Array<{ cache_control?: { type: string } }>).filter((block) => block.cache_control),
            ...(parsed.messages as Array<{ content: unknown }>).flatMap((message) =>
                Array.isArray(message.content)
                    ? (message.content as Array<{ cache_control?: { type: string } }>).filter((block) => block.cache_control)
                    : [],
            ),
        ];

        expect(cacheControlledBlocks).toHaveLength(4);
    });

    it("adds context_management by default when signature emulation is enabled", () => {
        const body = JSON.stringify({
            model: "claude-opus-4-6",
            thinking: { type: "adaptive" },
            messages: [{ role: "user", content: "hi" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, true);
        const parsed = JSON.parse(result!);

        expect(parsed.context_management).toEqual({
            edits: [{ type: "clear_thinking_20251015", keep: "all" }],
        });
    });

    it("does not relocate when signature.enabled is false (legacy passthrough)", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, { ...mockSignature, enabled: false }, mockRuntime);
        const parsed = JSON.parse(result!);

        const systemJoined = parsed.system.map((b: { text: string }) => b.text).join("\n");
        expect(systemJoined).toContain("Plugin instructions");
        expect(parsed.messages[0].content).toBe("hi");
    });

    it("does not relocate when relocateThirdPartyPrompts arg is false", () => {
        const body = JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
            system: [{ type: "text", text: "Plugin instructions" }],
        });

        const result = transformRequestBody(body, mockSignature, mockRuntime, false);
        const parsed = JSON.parse(result!);

        const systemJoined = parsed.system.map((b: { text: string }) => b.text).join("\n");
        expect(systemJoined).toContain("Plugin instructions");
        expect(parsed.messages[0].content).toBe("hi");
    });
});
