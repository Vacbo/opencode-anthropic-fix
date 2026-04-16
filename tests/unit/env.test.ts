// Characterization tests for src/env.ts helpers.
//
// Pins the observable behavior of env-parsing primitives so the upcoming
// root-package-decomposition (cluster C5) cannot silently regress these
// contracts while env.ts is moved or split.

import { afterEach, describe, expect, it } from "vitest";
import { isFalsyEnv, isTruthyEnv, parseAnthropicCustomHeaders } from "../../src/env.js";

describe("isTruthyEnv", () => {
    it("returns false for undefined or empty", () => {
        expect(isTruthyEnv(undefined)).toBe(false);
        expect(isTruthyEnv("")).toBe(false);
    });

    it("recognizes the canonical truthy tokens regardless of case/whitespace", () => {
        for (const value of ["1", "true", "yes", " TRUE ", "Yes", "tRuE"]) {
            expect(isTruthyEnv(value)).toBe(true);
        }
    });

    it("rejects non-truthy tokens", () => {
        for (const value of ["0", "false", "no", "2", "on", "y", "t", "enabled", "  "]) {
            expect(isTruthyEnv(value)).toBe(false);
        }
    });
});

describe("isFalsyEnv", () => {
    it("returns false for undefined or empty", () => {
        expect(isFalsyEnv(undefined)).toBe(false);
        expect(isFalsyEnv("")).toBe(false);
    });

    it("recognizes the canonical falsy tokens regardless of case/whitespace", () => {
        for (const value of ["0", "false", "no", " FALSE ", "No", "nO"]) {
            expect(isFalsyEnv(value)).toBe(true);
        }
    });

    it("rejects non-falsy tokens", () => {
        for (const value of ["1", "true", "yes", "off", "disabled", "  "]) {
            expect(isFalsyEnv(value)).toBe(false);
        }
    });
});

describe("parseAnthropicCustomHeaders", () => {
    const originalValue = process.env.ANTHROPIC_CUSTOM_HEADERS;

    afterEach(() => {
        if (originalValue === undefined) {
            delete process.env.ANTHROPIC_CUSTOM_HEADERS;
        } else {
            process.env.ANTHROPIC_CUSTOM_HEADERS = originalValue;
        }
    });

    it("returns an empty object when the env var is unset", () => {
        delete process.env.ANTHROPIC_CUSTOM_HEADERS;
        expect(parseAnthropicCustomHeaders()).toEqual({});
    });

    it("returns an empty object when the env var is empty string", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = "";
        expect(parseAnthropicCustomHeaders()).toEqual({});
    });

    it("parses a single header line", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Debug: 1";
        expect(parseAnthropicCustomHeaders()).toEqual({ "X-Debug": "1" });
    });

    it("parses multiple header lines separated by \\n or \\r\\n", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = "X-A: alpha\nX-B: beta\r\nX-C: gamma";
        expect(parseAnthropicCustomHeaders()).toEqual({
            "X-A": "alpha",
            "X-B": "beta",
            "X-C": "gamma",
        });
    });

    it("trims whitespace around keys and values", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = "  X-Spaced  :   trimmed value  ";
        expect(parseAnthropicCustomHeaders()).toEqual({ "X-Spaced": "trimmed value" });
    });

    it("preserves colons inside header values", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Proxy: host:8080";
        expect(parseAnthropicCustomHeaders()).toEqual({ "X-Proxy": "host:8080" });
    });

    it("skips blank lines, lines without a colon, and lines with leading colon", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = ["", "garbage-no-colon", ":no-key", "X-Real: ok", "   "].join("\n");
        expect(parseAnthropicCustomHeaders()).toEqual({ "X-Real": "ok" });
    });

    it("skips headers with empty keys or values after trimming", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = ["X-Empty-Value: ", "X-Ok: value"].join("\n");
        expect(parseAnthropicCustomHeaders()).toEqual({ "X-Ok": "value" });
    });

    it("preserves the last occurrence when the same key appears twice", () => {
        process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Dup: one\nX-Dup: two";
        expect(parseAnthropicCustomHeaders()).toEqual({ "X-Dup": "two" });
    });
});
