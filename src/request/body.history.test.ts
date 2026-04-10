// ---------------------------------------------------------------------------
// Body transformation tests - TDD RED phase
// Tests for tool name drift defense and body handling edge cases
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  transformRequestBody,
  validateBodyType,
  cloneBodyForRetry,
  detectDoublePrefix,
  extractToolNamesFromBody,
} from "./body.js";
import type { RuntimeContext, SignatureConfig } from "../types.js";

const mockRuntime: RuntimeContext = {
  persistentUserId: "user-123",
  accountId: "acc-456",
  sessionId: "sess-789",
};

const mockSignature: SignatureConfig = {
  enabled: true,
  version: "0.2.45",
  headers: {
    "x-anthropic-client-name": "claude-code",
    "x-anthropic-client-version": "0.2.45",
    "x-anthropic-stainless-timeout": "600000",
  },
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
        /body must be a string/,
      );
    }
  });

  it("should validate body type at runtime with descriptive error", () => {
    const debugLog = vi.fn();
    const body = { not: "a string" };

    expect(() =>
      transformRequestBody(body as unknown as string, mockSignature, mockRuntime, true, false, debugLog),
    ).toThrow(/Invalid body type: expected string, received object/);
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

  it("should strip existing mcp_ prefix before adding new prefix", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
      tools: [{ name: "mcp_read_file", description: "Read a file" }],
    });

    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);

    // Should normalize to single prefix, not double
    expect(parsed.tools[0].name).toBe("mcp_read_file");
    expect(parsed.tools[0].name).not.toBe("mcp_mcp_read_file");
  });

  it("should handle tools already prefixed with mcp_ correctly", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      tools: [
        { name: "mcp_server1__tool1", description: "Tool 1" },
        { name: "mcp_server2__tool2", description: "Tool 2" },
      ],
    });

    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);

    // Should preserve the existing mcp_ prefix structure
    expect(parsed.tools[0].name).toBe("mcp_server1__tool1");
    expect(parsed.tools[1].name).toBe("mcp_server2__tool2");
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

    // Both calls should produce identical results from same input
    expect(result1).toBe(result2);

    // Original should be unchanged
    const parsedOriginal = JSON.parse(originalBody);
    expect(parsedOriginal.tools[0].name).toBe("read_file");
  });

  it("should fail gracefully when body has been consumed", () => {
    // Simulate a consumed body (e.g., ReadableStream that's been read)
    const consumedBody = "" as string;

    expect(() => transformRequestBody(consumedBody, mockSignature, mockRuntime)).toThrow(/Body has been consumed/);
  });

  it("should handle retry with same body multiple times", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "test" }],
    });

    // First attempt
    const result1 = transformRequestBody(body, mockSignature, mockRuntime);
    expect(result1).toBeDefined();

    // Retry attempt - should work with same body
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

    expect(parsed.tools[0].name).toBe("mcp_read_file");
    expect(parsed.tools[1].name).toBe("mcp_write_file");
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
    expect(parsed.messages[0].content[0].name).toBe("mcp_read_file");
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

    expect(parsed.tools[0].name).toBe("mcp_read_file");
    expect(parsed.tools[1].name).toBe("mcp_existing_tool");
    expect(parsed.tools[2].name).toBe("mcp_write_file");
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
    expect(parsed.system).toHaveLength(1);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.metadata.user_id).toBe("test-user");
  });

  it("should handle request with body in input correctly", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [
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

    expect(parsed.messages[0].content).toHaveLength(2);
    expect(parsed.messages[0].content[0].type).toBe("text");
    expect(parsed.messages[0].content[1].type).toBe("tool_result");
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
      /Invalid body type: expected string, received number/,
    );
  });
});

describe("cloneBodyForRetry", () => {
  it("should return new string instance for retry", () => {
    const original = '{"test": true}';
    const cloned = cloneBodyForRetry(original);

    expect(cloned).toBe(original);
    expect(cloned).not.toBe(original); // Different reference
  });

  it("should throw when body is consumed", () => {
    expect(() => cloneBodyForRetry("")).toThrow(/Body has been consumed/);
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
