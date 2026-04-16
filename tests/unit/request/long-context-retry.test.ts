import { afterEach, describe, expect, it } from "vitest";
import {
    clearLongContextExclusions,
    getLongContextExclusions,
    isLongContextError,
    nextLongContextExclusion,
    recordLongContextExclusion,
} from "../../../src/request/long-context-retry.js";

describe("isLongContextError", () => {
    it("detects the 'Extra usage is required' marker", () => {
        const body = JSON.stringify({
            error: { message: "Extra usage is required for long context requests" },
        });
        expect(isLongContextError(body)).toBe(true);
    });

    it("detects the 'long context beta is not yet available' marker", () => {
        expect(isLongContextError("long context beta is not yet available for account")).toBe(true);
    });

    it("detects the 'long_context_beta' internal code marker", () => {
        expect(isLongContextError('{"error":{"code":"long_context_beta"}}')).toBe(true);
    });

    it("returns false for unrelated 400 error bodies", () => {
        expect(isLongContextError("invalid_api_key")).toBe(false);
        expect(isLongContextError("rate_limit_exceeded")).toBe(false);
    });

    it("returns false for nullish input", () => {
        expect(isLongContextError(null)).toBe(false);
        expect(isLongContextError(undefined)).toBe(false);
        expect(isLongContextError("")).toBe(false);
    });
});

describe("long-context exclusion state machine", () => {
    afterEach(() => {
        clearLongContextExclusions();
    });

    it("returns the first unexcluded beta in priority order", () => {
        expect(nextLongContextExclusion("claude-opus-4-6")).toBe("context-1m-2025-08-07");
    });

    it("advances to the next beta after recording an exclusion", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");
        expect(nextLongContextExclusion("claude-opus-4-6")).toBe("interleaved-thinking-2025-05-14");
    });

    it("returns null when all excludable betas are exhausted", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");
        recordLongContextExclusion("claude-opus-4-6", "interleaved-thinking-2025-05-14");
        expect(nextLongContextExclusion("claude-opus-4-6")).toBeNull();
    });

    it("isolates exclusions per model", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");
        expect(nextLongContextExclusion("claude-opus-4-7")).toBe("context-1m-2025-08-07");
    });

    it("exposes the current exclusion set for header building", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");
        const excluded = getLongContextExclusions("claude-opus-4-6");
        expect(excluded.has("context-1m-2025-08-07")).toBe(true);
        expect(excluded.has("interleaved-thinking-2025-05-14")).toBe(false);
    });

    it("returns empty set for models with no recorded exclusions", () => {
        expect(getLongContextExclusions("claude-sonnet-4-6").size).toBe(0);
    });

    it("clearLongContextExclusions with a model clears only that model", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");
        recordLongContextExclusion("claude-opus-4-7", "context-1m-2025-08-07");
        clearLongContextExclusions("claude-opus-4-6");
        expect(getLongContextExclusions("claude-opus-4-6").size).toBe(0);
        expect(getLongContextExclusions("claude-opus-4-7").size).toBe(1);
    });

    it("clearLongContextExclusions with no argument clears all state", () => {
        recordLongContextExclusion("claude-opus-4-6", "context-1m-2025-08-07");
        recordLongContextExclusion("claude-opus-4-7", "interleaved-thinking-2025-05-14");
        clearLongContextExclusions();
        expect(getLongContextExclusions("claude-opus-4-6").size).toBe(0);
        expect(getLongContextExclusions("claude-opus-4-7").size).toBe(0);
    });
});
