/**
 * Smoke tests for conversation-history helper.
 *
 * Validates factory functions create valid Anthropic Messages API structures
 * and that tool_use/tool_result pairing works correctly.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  makeConversation,
  makeMessage,
  makeToolUse,
  makeToolResult,
  makeTextBlock,
  makeToolExchange,
  makeToolConversation,
  validateToolPair,
  findToolResult,
  validateConversationTools,
  generateToolUseId,
  resetIdCounter,
  type Message,
} from "./conversation-history.js";

describe("conversation-history factories", () => {
  beforeEach(() => {
    resetIdCounter();
  });

  describe("makeConversation", () => {
    it("creates empty conversation by default", () => {
      const conv = makeConversation();

      expect(conv.messages).toEqual([]);
      expect(conv.metadata).toBeUndefined();
    });

    it("creates conversation with messages", () => {
      const messages = [makeMessage({ role: "user", content: "Hello" })];
      const conv = makeConversation({ messages });

      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0].role).toBe("user");
    });

    it("creates conversation with metadata", () => {
      const conv = makeConversation({
        metadata: { sessionId: "test-123", model: "claude-sonnet" },
      });

      expect(conv.metadata).toEqual({ sessionId: "test-123", model: "claude-sonnet" });
    });
  });

  describe("makeMessage", () => {
    it("creates user message by default", () => {
      const msg = makeMessage();

      expect(msg.role).toBe("user");
      expect(msg.content).toBe("");
    });

    it("creates message with string content", () => {
      const msg = makeMessage({ role: "user", content: "Hello Claude" });

      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Hello Claude");
    });

    it("creates assistant message with content blocks", () => {
      const msg = makeMessage({
        role: "assistant",
        content: [makeTextBlock("Hello!")],
      });

      expect(msg.role).toBe("assistant");
      expect(Array.isArray(msg.content)).toBe(true);
      expect((msg.content as Array<{ type: string }>)[0].type).toBe("text");
    });
  });

  describe("makeTextBlock", () => {
    it("creates text block with correct type", () => {
      const block = makeTextBlock("Hello world");

      expect(block.type).toBe("text");
      expect(block.text).toBe("Hello world");
    });
  });

  describe("makeToolUse", () => {
    it("creates tool_use with auto-generated ID", () => {
      const tool = makeToolUse();

      expect(tool.type).toBe("tool_use");
      expect(tool.id).toMatch(/^tu_[a-f0-9]+_\d+$/);
      expect(tool.name).toBe("unnamed_tool");
      expect(tool.input).toEqual({});
    });

    it("creates tool_use with custom properties", () => {
      const tool = makeToolUse({
        id: "custom_id",
        name: "read_file",
        input: { path: "test.txt", offset: 0 },
      });

      expect(tool.id).toBe("custom_id");
      expect(tool.name).toBe("read_file");
      expect(tool.input).toEqual({ path: "test.txt", offset: 0 });
    });

    it("generates unique IDs for multiple tools", () => {
      const tool1 = makeToolUse();
      const tool2 = makeToolUse();

      expect(tool1.id).not.toBe(tool2.id);
    });
  });

  describe("makeToolResult", () => {
    it("creates tool_result with auto-generated tool_use_id", () => {
      const result = makeToolResult();

      expect(result.type).toBe("tool_result");
      expect(result.tool_use_id).toMatch(/^tr_[a-f0-9]+_\d+$/);
      expect(result.content).toBe("");
      expect(result.is_error).toBe(false);
    });

    it("creates tool_result with custom properties", () => {
      const result = makeToolResult({
        toolUseId: "tu_abc123",
        content: "File contents here",
        isError: true,
      });

      expect(result.tool_use_id).toBe("tu_abc123");
      expect(result.content).toBe("File contents here");
      expect(result.is_error).toBe(true);
    });

    it("creates tool_result with content blocks", () => {
      const result = makeToolResult({
        toolUseId: "tu_123",
        content: [makeTextBlock("Result text")],
      });

      expect(Array.isArray(result.content)).toBe(true);
      expect((result.content as Array<{ type: string }>)[0].type).toBe("text");
    });
  });

  describe("tool pairing validation", () => {
    it("validates matching tool_use and tool_result pair", () => {
      const toolUse = makeToolUse({ id: "tu_test123", name: "read_file" });
      const toolResult = makeToolResult({ toolUseId: "tu_test123", content: "data" });

      expect(validateToolPair(toolUse, toolResult)).toBe(true);
    });

    it("rejects mismatched tool pair", () => {
      const toolUse = makeToolUse({ id: "tu_abc" });
      const toolResult = makeToolResult({ toolUseId: "tu_xyz" });

      expect(validateToolPair(toolUse, toolResult)).toBe(false);
    });

    it("finds tool_result by ID in message array", () => {
      const toolUse = makeToolUse({ id: "tu_findme" });
      const toolResult = makeToolResult({ toolUseId: "tu_findme", content: "found" });

      const messages: Message[] = [
        makeMessage({ role: "assistant", content: [toolUse] }),
        makeMessage({ role: "user", content: [toolResult] }),
      ];

      const found = findToolResult(messages, "tu_findme");
      expect(found).toBeDefined();
      expect(found?.content).toBe("found");
    });

    it("returns undefined when tool_result not found", () => {
      const messages: Message[] = [makeMessage({ role: "user", content: "Hello" })];

      const found = findToolResult(messages, "tu_missing");
      expect(found).toBeUndefined();
    });
  });

  describe("conversation tool validation", () => {
    it("validates conversation with complete tool pairs", () => {
      const toolUse = makeToolUse({ id: "tu_complete" });
      const toolResult = makeToolResult({ toolUseId: "tu_complete" });

      const conv = makeConversation({
        messages: [
          makeMessage({ role: "user", content: "Use tool" }),
          makeMessage({ role: "assistant", content: [toolUse] }),
          makeMessage({ role: "user", content: [toolResult] }),
        ],
      });

      const validation = validateConversationTools(conv);
      expect(validation.valid).toBe(true);
      expect(validation.unmatchedToolUses).toHaveLength(0);
      expect(validation.unmatchedToolResults).toHaveLength(0);
    });

    it("detects unmatched tool_use blocks", () => {
      const toolUse = makeToolUse({ id: "tu_unmatched" });

      const conv = makeConversation({
        messages: [makeMessage({ role: "assistant", content: [toolUse] })],
      });

      const validation = validateConversationTools(conv);
      expect(validation.valid).toBe(false);
      expect(validation.unmatchedToolUses).toHaveLength(1);
      expect(validation.unmatchedToolResults).toHaveLength(0);
    });

    it("detects unmatched tool_result blocks", () => {
      const toolResult = makeToolResult({ toolUseId: "tu_missing" });

      const conv = makeConversation({
        messages: [makeMessage({ role: "user", content: [toolResult] })],
      });

      const validation = validateConversationTools(conv);
      expect(validation.valid).toBe(false);
      expect(validation.unmatchedToolUses).toHaveLength(0);
      expect(validation.unmatchedToolResults).toHaveLength(1);
    });
  });

  describe("makeToolExchange", () => {
    it("creates paired tool_use and tool_result", () => {
      const [toolUse, toolResult] = makeToolExchange("read_file", { path: "test.txt" }, "file contents");

      expect(toolUse.type).toBe("tool_use");
      expect(toolUse.name).toBe("read_file");
      expect(toolUse.input).toEqual({ path: "test.txt" });

      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.tool_use_id).toBe(toolUse.id);
      expect(toolResult.content).toBe("file contents");

      expect(validateToolPair(toolUse, toolResult)).toBe(true);
    });
  });

  describe("makeToolConversation", () => {
    it("creates complete tool conversation flow", () => {
      const conv = makeToolConversation(
        "Read the config file",
        "read_file",
        { path: ".config" },
        '{ "setting": true }',
      );

      expect(conv.messages).toHaveLength(3);

      // User request
      expect(conv.messages[0].role).toBe("user");
      expect(conv.messages[0].content).toBe("Read the config file");

      // Assistant tool use
      expect(conv.messages[1].role).toBe("assistant");
      const assistantContent = conv.messages[1].content as Array<{ type: string; name?: string }>;
      expect(assistantContent[0].type).toBe("tool_use");
      expect(assistantContent[0].name).toBe("read_file");

      // User tool result
      expect(conv.messages[2].role).toBe("user");
      const userContent = conv.messages[2].content as Array<{ type: string }>;
      expect(userContent[0].type).toBe("tool_result");

      // Validate pairing
      const validation = validateConversationTools(conv);
      expect(validation.valid).toBe(true);
    });
  });

  describe("ID generation", () => {
    it("generates unique IDs with different prefixes", () => {
      const id1 = generateToolUseId("tu");
      const id2 = generateToolUseId("tr");

      expect(id1.startsWith("tu_")).toBe(true);
      expect(id2.startsWith("tr_")).toBe(true);
      expect(id1).not.toBe(id2);
    });

    it("resets counter for deterministic tests", () => {
      makeToolUse();

      resetIdCounter();

      const tool2 = makeToolUse();
      const counter2 = parseInt(tool2.id.split("_").pop() || "0", 10);

      expect(counter2).toBe(1);
    });
  });

  describe("complex conversation scenarios", () => {
    it("handles mixed content types", () => {
      const imageBlock = {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "abc123" },
      };

      const conv = makeConversation({
        messages: [
          makeMessage({
            role: "user",
            content: [makeTextBlock("Please analyze this:"), imageBlock],
          }),
          makeMessage({
            role: "assistant",
            content: [makeToolUse({ name: "analyze_image" })],
          }),
        ],
      });

      expect(conv.messages[0].role).toBe("user");
      const userContent = conv.messages[0].content as Array<{ type: string }>;
      expect(userContent).toHaveLength(2);
      expect(userContent[0].type).toBe("text");
      expect(userContent[1].type).toBe("image");
    });
  });
});
