import { describe, expect, it } from "vitest";
import {
    hasOneMillionContext,
    isAdaptiveThinkingModel,
    isHaikuModel,
    isOpus46Model,
    isSonnet46Model,
    supportsContextManagement,
    supportsStructuredOutputs,
    supportsThinking,
} from "../../src/models.js";

describe("isHaikuModel", () => {
    it("matches current and legacy Haiku IDs", () => {
        expect(isHaikuModel("claude-haiku-4-5-20251001")).toBe(true);
        expect(isHaikuModel("claude-3-haiku-20240307")).toBe(true);
        expect(isHaikuModel("claude-3-5-haiku-20241022")).toBe(true);
    });

    it("does not match Sonnet or Opus", () => {
        expect(isHaikuModel("claude-sonnet-4-6")).toBe(false);
        expect(isHaikuModel("claude-opus-4-7")).toBe(false);
    });
});

describe("isOpus46Model", () => {
    it("matches Opus 4.6 and 4.7 across wire-name variants", () => {
        expect(isOpus46Model("claude-opus-4-6")).toBe(true);
        expect(isOpus46Model("claude-opus-4-7")).toBe(true);
        expect(isOpus46Model("claude-opus-4.6")).toBe(true);
        expect(isOpus46Model("arn:aws:bedrock:us-west-2::anthropic.claude-opus-4-7-v1:0")).toBe(true);
    });

    it("does not match older Opus or Sonnet", () => {
        expect(isOpus46Model("claude-opus-4-1-20250805")).toBe(false);
        expect(isOpus46Model("claude-sonnet-4-6")).toBe(false);
    });
});

describe("isSonnet46Model", () => {
    it("matches Sonnet 4.6 and 4.7 across wire-name variants", () => {
        expect(isSonnet46Model("claude-sonnet-4-6")).toBe(true);
        expect(isSonnet46Model("claude-sonnet-4-7")).toBe(true);
        expect(isSonnet46Model("sonnet-4.6")).toBe(true);
    });

    it("does not match Sonnet 4 or 4.5", () => {
        expect(isSonnet46Model("claude-sonnet-4-20250514")).toBe(false);
        expect(isSonnet46Model("claude-sonnet-4-5-20250929")).toBe(false);
    });
});

describe("isAdaptiveThinkingModel", () => {
    it("returns true for Sonnet 4.6 and Opus 4.6+", () => {
        expect(isAdaptiveThinkingModel("claude-sonnet-4-6")).toBe(true);
        expect(isAdaptiveThinkingModel("claude-opus-4-6")).toBe(true);
        expect(isAdaptiveThinkingModel("claude-opus-4-7")).toBe(true);
    });

    it("returns false for Haiku 4.5 (capability API: adaptive.supported=false)", () => {
        expect(isAdaptiveThinkingModel("claude-haiku-4-5-20251001")).toBe(false);
    });

    it("returns false for older Sonnet/Opus", () => {
        expect(isAdaptiveThinkingModel("claude-opus-4-1-20250805")).toBe(false);
        expect(isAdaptiveThinkingModel("claude-sonnet-4-5-20250929")).toBe(false);
    });
});

describe("hasOneMillionContext", () => {
    it("returns true for Opus 4.6+ (1M by default)", () => {
        expect(hasOneMillionContext("claude-opus-4-6")).toBe(true);
        expect(hasOneMillionContext("claude-opus-4-7")).toBe(true);
    });

    it("returns true for Sonnet 4.6+ (live API: max_input_tokens=1000000)", () => {
        expect(hasOneMillionContext("claude-sonnet-4-6")).toBe(true);
        expect(hasOneMillionContext("claude-sonnet-4-7")).toBe(true);
    });

    it("returns true for IDs with explicit 1m suffix", () => {
        expect(hasOneMillionContext("claude-opus-4-1-1m")).toBe(true);
        expect(hasOneMillionContext("claude-sonnet-4-context-1m")).toBe(true);
    });

    it("returns false for 200K-context models", () => {
        expect(hasOneMillionContext("claude-haiku-4-5-20251001")).toBe(false);
        expect(hasOneMillionContext("claude-opus-4-1-20250805")).toBe(false);
        expect(hasOneMillionContext("claude-3-haiku-20240307")).toBe(false);
    });
});

describe("supportsStructuredOutputs", () => {
    it("returns true for Haiku 4.5+ (capability API: structured_outputs.supported=true)", () => {
        expect(supportsStructuredOutputs("claude-haiku-4-5-20251001")).toBe(true);
    });

    it("returns false for Claude 3 Haiku variants", () => {
        expect(supportsStructuredOutputs("claude-3-haiku-20240307")).toBe(false);
        expect(supportsStructuredOutputs("claude-3-5-haiku-20241022")).toBe(false);
    });

    it("returns true for modern Sonnet and Opus", () => {
        expect(supportsStructuredOutputs("claude-sonnet-4-6")).toBe(true);
        expect(supportsStructuredOutputs("claude-opus-4-7")).toBe(true);
    });

    it("returns false for non-Claude models", () => {
        expect(supportsStructuredOutputs("gpt-4")).toBe(false);
        expect(supportsStructuredOutputs("")).toBe(false);
    });
});

describe("supportsContextManagement", () => {
    it("returns true for Claude 4+ models", () => {
        expect(supportsContextManagement("claude-haiku-4-5-20251001")).toBe(true);
        expect(supportsContextManagement("claude-sonnet-4-6")).toBe(true);
        expect(supportsContextManagement("claude-opus-4-7")).toBe(true);
    });

    it("returns false for Claude 3.x", () => {
        expect(supportsContextManagement("claude-3-haiku-20240307")).toBe(false);
        expect(supportsContextManagement("claude-3-5-sonnet-20241022")).toBe(false);
    });
});

describe("supportsThinking", () => {
    it("returns true for any Claude model", () => {
        expect(supportsThinking("claude-haiku-4-5-20251001")).toBe(true);
        expect(supportsThinking("claude-sonnet-4-6")).toBe(true);
        expect(supportsThinking("claude-opus-4-7")).toBe(true);
        expect(supportsThinking("claude-3-haiku-20240307")).toBe(true);
    });

    it("returns true for empty model (permissive default)", () => {
        expect(supportsThinking("")).toBe(true);
    });
});
