import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, isDebugEnabled, redact } from "../../src/logger.js";

describe("redact", () => {
    it("masks bearer tokens inside plain strings", () => {
        const result = redact("Authorization: Bearer sk-ant-oat01-abcdef0123456789_abcdef-0123");
        expect(result).toBe("Authorization: Bearer <redacted-bearer>");
    });

    it("masks common credential keys inside objects", () => {
        const payload = {
            access: "sk-ant-oat01-realtoken12345",
            refresh: "sk-ant-oat01-refreshtokenabcde",
            access_token: "sk-ant-oat01-abcdef0123456789",
            accessToken: "sk-ant-oat01-camelcase1234567890",
            refreshToken: "sk-ant-oat01-anotherToken123456",
            token: "sk-ant-oat01-xyzxyzxyzxyz123",
            bearer: "sk-ant-oat01-bearer1234567890",
            authorization: "Bearer sk-ant-oat01-authtok1234567890",
            unrelated: "kept",
        };
        expect(redact(payload)).toEqual({
            access: "<redacted>",
            refresh: "<redacted>",
            access_token: "<redacted>",
            accessToken: "<redacted>",
            refreshToken: "<redacted>",
            token: "<redacted>",
            bearer: "<redacted>",
            authorization: "<redacted>",
            unrelated: "kept",
        });
    });

    it("masks bearer tokens in nested structures without mangling structure", () => {
        const payload = {
            headers: { "x-other": "value", auth: "Bearer sk-ant-oat01-deeptoken1234567890" },
            messages: ["hello", "my token is sk-ant-oat01-inlinetoken1234567890"],
        };
        expect(redact(payload)).toEqual({
            headers: { "x-other": "value", auth: "Bearer <redacted-bearer>" },
            messages: ["hello", "my token is <redacted-bearer>"],
        });
    });

    it("redacts Error instances (message + stack) while preserving name", () => {
        const error = new Error("failed: sk-ant-oat01-exampletoken0123456789");
        const result = redact(error) as { name: string; message: string; stack?: string };
        expect(result.name).toBe("Error");
        expect(result.message).toBe("failed: <redacted-bearer>");
        expect(result.stack).not.toMatch(/sk-ant-oat01-[A-Za-z0-9]/);
    });

    it("passes through null, undefined, numbers, and booleans unchanged", () => {
        expect(redact(null)).toBeNull();
        expect(redact(undefined)).toBeUndefined();
        expect(redact(42)).toBe(42);
        expect(redact(true)).toBe(true);
    });
});

describe("isDebugEnabled", () => {
    const original = process.env.OPENCODE_ANTHROPIC_DEBUG;
    afterEach(() => {
        if (original === undefined) delete process.env.OPENCODE_ANTHROPIC_DEBUG;
        else process.env.OPENCODE_ANTHROPIC_DEBUG = original;
    });

    it("is false when the env var is unset", () => {
        delete process.env.OPENCODE_ANTHROPIC_DEBUG;
        expect(isDebugEnabled()).toBe(false);
    });

    it("is true for '1', 'true', 'yes' (case-insensitive)", () => {
        for (const value of ["1", "true", "TRUE", "yes", "YES"]) {
            process.env.OPENCODE_ANTHROPIC_DEBUG = value;
            expect(isDebugEnabled()).toBe(true);
        }
    });

    it("is false for falsy values", () => {
        for (const value of ["", "0", "false", "no"]) {
            process.env.OPENCODE_ANTHROPIC_DEBUG = value;
            expect(isDebugEnabled()).toBe(false);
        }
    });
});

describe("createLogger", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    const original = process.env.OPENCODE_ANTHROPIC_DEBUG;

    beforeEach(() => {
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        if (original === undefined) delete process.env.OPENCODE_ANTHROPIC_DEBUG;
        else process.env.OPENCODE_ANTHROPIC_DEBUG = original;
    });

    it("debug is a no-op when debug is disabled", () => {
        delete process.env.OPENCODE_ANTHROPIC_DEBUG;
        const logger = createLogger("test-scope");
        logger.debug("silenced");
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("debug writes a single JSON line to stdout when debug is enabled", () => {
        process.env.OPENCODE_ANTHROPIC_DEBUG = "1";
        const logger = createLogger("oauth");
        logger.debug("refresh succeeded", { accountId: "abc" });
        expect(logSpy).toHaveBeenCalledTimes(1);
        const line = logSpy.mock.calls[0][0] as string;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.level).toBe("debug");
        expect(parsed.scope).toBe("oauth");
        expect(parsed.message).toBe("refresh succeeded");
        expect(parsed.accountId).toBe("abc");
        expect(typeof parsed.timestamp).toBe("string");
    });

    it("warn + error always emit to stderr regardless of debug flag", () => {
        delete process.env.OPENCODE_ANTHROPIC_DEBUG;
        const logger = createLogger("oauth");
        logger.warn("non-fatal");
        logger.error("fatal");
        expect(errorSpy).toHaveBeenCalledTimes(2);
        expect(logSpy).not.toHaveBeenCalled();
    });

    it("redacts bearer tokens inside field payloads", () => {
        process.env.OPENCODE_ANTHROPIC_DEBUG = "1";
        const logger = createLogger("token-refresh");
        logger.debug("token received", {
            access: "sk-ant-oat01-realtoken12345678",
            note: "header was Bearer sk-ant-oat01-extraToken123456",
        });
        const line = logSpy.mock.calls[0][0] as string;
        expect(line).not.toMatch(/sk-ant-oat01-[A-Za-z0-9]/);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed.access).toBe("<redacted>");
        expect(parsed.note).toBe("header was Bearer <redacted-bearer>");
    });
});
