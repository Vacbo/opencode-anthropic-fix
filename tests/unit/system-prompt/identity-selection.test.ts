import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    INTERACTIVE_CLAUDE_CODE_IDENTITY,
    NON_INTERACTIVE_CLAUDE_AGENT_IDENTITY,
    NON_INTERACTIVE_CLAUDE_CODE_AGENT_SDK_IDENTITY,
    selectClaudeCodeIdentity,
} from "../../../src/constants.js";

describe("selectClaudeCodeIdentity — matches decompiled CC 2.1.113 zN_() logic", () => {
    let originalTTY: boolean | undefined;
    let originalCI: string | undefined;

    beforeEach(() => {
        originalTTY = process.stdout.isTTY;
        originalCI = process.env.CI;
        delete process.env.CI;
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    });

    afterEach(() => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalTTY });
        if (originalCI !== undefined) process.env.CI = originalCI;
    });

    it("returns qI6 (Claude Code) for interactive mode (TTY + not CI, no append-system-prompt)", () => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
        expect(selectClaudeCodeIdentity({ provider: "anthropic" })).toBe(INTERACTIVE_CLAUDE_CODE_IDENTITY);
        expect(INTERACTIVE_CLAUDE_CODE_IDENTITY).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    });

    it("returns Doq (Claude agent) for non-interactive mode without append-system-prompt", () => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
        expect(selectClaudeCodeIdentity({ provider: "anthropic" })).toBe(NON_INTERACTIVE_CLAUDE_AGENT_IDENTITY);
        expect(NON_INTERACTIVE_CLAUDE_AGENT_IDENTITY).toBe(
            "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        );
    });

    it("returns joq (Claude Code with Agent SDK) for non-interactive mode WITH append-system-prompt", () => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
        expect(selectClaudeCodeIdentity({ provider: "anthropic", hasAppendSystemPrompt: true })).toBe(
            NON_INTERACTIVE_CLAUDE_CODE_AGENT_SDK_IDENTITY,
        );
        expect(NON_INTERACTIVE_CLAUDE_CODE_AGENT_SDK_IDENTITY).toBe(
            "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
        );
    });

    it("returns qI6 (Claude Code) for vertex provider regardless of mode", () => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
        expect(selectClaudeCodeIdentity({ provider: "vertex" })).toBe(INTERACTIVE_CLAUDE_CODE_IDENTITY);
        expect(selectClaudeCodeIdentity({ provider: "vertex", hasAppendSystemPrompt: true })).toBe(
            INTERACTIVE_CLAUDE_CODE_IDENTITY,
        );
    });

    it("treats CI env var as non-interactive", () => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
        process.env.CI = "true";
        expect(selectClaudeCodeIdentity({ provider: "anthropic" })).toBe(NON_INTERACTIVE_CLAUDE_AGENT_IDENTITY);
    });

    it("defaults to interactive identity when provider is missing", () => {
        Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
        expect(selectClaudeCodeIdentity({})).toBe(INTERACTIVE_CLAUDE_CODE_IDENTITY);
    });
});
