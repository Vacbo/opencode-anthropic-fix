/**
 * Direct unit tests for cli/formatting.ts
 *
 * Tests all pure formatting helpers: ANSI color, duration formatting,
 * progress bars, padding, token formatting, and usage rendering.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    ansi,
    c,
    fmtTokens,
    formatDuration,
    formatResetTime,
    formatTimeAgo,
    pad,
    QUOTA_BUCKETS,
    renderBar,
    renderUsageLines,
    rpad,
    setUseColor,
    shortPath,
    stripAnsi,
} from "../../../src/cli/formatting.js";

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

describe("ansi — ANSI escape wrapping", () => {
    beforeEach(() => setUseColor(true));
    afterEach(() => setUseColor(true));

    it("wraps text with ANSI codes when color is enabled", () => {
        expect(ansi("32", "hello")).toBe("\x1b[32mhello\x1b[0m");
    });

    it("returns plain text when color is disabled", () => {
        setUseColor(false);
        expect(ansi("32", "hello")).toBe("hello");
    });
});

describe("c — color shorthand object", () => {
    beforeEach(() => setUseColor(true));
    afterEach(() => setUseColor(true));

    it("bold wraps with code 1", () => {
        expect(c.bold("test")).toContain("\x1b[1m");
        expect(c.bold("test")).toContain("test");
    });

    it("dim wraps with code 2", () => {
        expect(c.dim("test")).toContain("\x1b[2m");
    });

    it("green wraps with code 32", () => {
        expect(c.green("ok")).toContain("\x1b[32m");
    });

    it("yellow wraps with code 33", () => {
        expect(c.yellow("warn")).toContain("\x1b[33m");
    });

    it("cyan wraps with code 36", () => {
        expect(c.cyan("info")).toContain("\x1b[36m");
    });

    it("red wraps with code 31", () => {
        expect(c.red("err")).toContain("\x1b[31m");
    });

    it("gray wraps with code 90", () => {
        expect(c.gray("muted")).toContain("\x1b[90m");
    });

    it("all functions return plain text when color disabled", () => {
        setUseColor(false);
        expect(c.bold("a")).toBe("a");
        expect(c.dim("b")).toBe("b");
        expect(c.green("c")).toBe("c");
        expect(c.red("d")).toBe("d");
    });
});

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi — ANSI removal", () => {
    it("returns plain text unchanged", () => {
        expect(stripAnsi("hello world")).toBe("hello world");
    });

    it("strips color codes", () => {
        expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
    });

    it("strips bold + dim", () => {
        expect(stripAnsi("\x1b[1mbold\x1b[0m \x1b[2mdim\x1b[0m")).toBe("bold dim");
    });

    it("strips nested codes", () => {
        expect(stripAnsi("\x1b[1m\x1b[31mred bold\x1b[0m\x1b[0m")).toBe("red bold");
    });

    it("handles empty string", () => {
        expect(stripAnsi("")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration — milliseconds to human string", () => {
    it("returns 'now' for zero or negative", () => {
        expect(formatDuration(0)).toBe("now");
        expect(formatDuration(-100)).toBe("now");
    });

    it("formats seconds", () => {
        expect(formatDuration(5000)).toBe("5s");
        expect(formatDuration(59000)).toBe("59s");
    });

    it("formats minutes", () => {
        expect(formatDuration(60_000)).toBe("1m");
        expect(formatDuration(90_000)).toBe("1m 30s");
    });

    it("formats hours", () => {
        expect(formatDuration(3_600_000)).toBe("1h");
        expect(formatDuration(5_400_000)).toBe("1h 30m");
    });

    it("formats days", () => {
        expect(formatDuration(86_400_000)).toBe("1d");
        expect(formatDuration(90_000_000)).toBe("1d 1h");
    });

    it("drops trailing zeroes at each level", () => {
        expect(formatDuration(120_000)).toBe("2m");
        expect(formatDuration(7_200_000)).toBe("2h");
        expect(formatDuration(172_800_000)).toBe("2d");
    });

    it("handles sub-second (rounds to 0s)", () => {
        expect(formatDuration(500)).toBe("0s");
    });
});

// ---------------------------------------------------------------------------
// formatTimeAgo
// ---------------------------------------------------------------------------

describe("formatTimeAgo — timestamp to relative string", () => {
    it("returns 'never' for null/undefined/zero", () => {
        expect(formatTimeAgo(null)).toBe("never");
        expect(formatTimeAgo(undefined)).toBe("never");
        expect(formatTimeAgo(0)).toBe("never");
    });

    it("returns 'just now' for future timestamps", () => {
        expect(formatTimeAgo(Date.now() + 60_000)).toBe("just now");
    });

    it("returns duration + 'ago' for past timestamps", () => {
        const fiveMinAgo = Date.now() - 300_000;
        expect(formatTimeAgo(fiveMinAgo)).toBe("5m ago");
    });
});

// ---------------------------------------------------------------------------
// formatResetTime
// ---------------------------------------------------------------------------

describe("formatResetTime — ISO date to remaining duration", () => {
    it("returns 'now' for past dates", () => {
        expect(formatResetTime("2020-01-01T00:00:00Z")).toBe("now");
    });

    it("returns duration for future dates", () => {
        const futureMs = Date.now() + 3_600_000;
        const result = formatResetTime(new Date(futureMs).toISOString());
        // Should contain 'h' or 'm' — at least not "now"
        expect(result).not.toBe("now");
        expect(result).toMatch(/\d+[hms]/);
    });
});

// ---------------------------------------------------------------------------
// shortPath
// ---------------------------------------------------------------------------

describe("shortPath — home directory abbreviation", () => {
    const originalHome = process.env.HOME;
    afterEach(() => {
        process.env.HOME = originalHome;
    });

    it("replaces HOME prefix with ~", () => {
        process.env.HOME = "/Users/testuser";
        expect(shortPath("/Users/testuser/.config/opencode/file.json")).toBe("~/.config/opencode/file.json");
    });

    it("returns path unchanged when HOME is not a prefix", () => {
        process.env.HOME = "/Users/testuser";
        expect(shortPath("/etc/config")).toBe("/etc/config");
    });

    it("handles missing HOME gracefully", () => {
        process.env.HOME = "";
        expect(shortPath("/some/path")).toBe("/some/path");
    });
});

// ---------------------------------------------------------------------------
// pad / rpad
// ---------------------------------------------------------------------------

describe("pad — left-pad to visible width", () => {
    beforeEach(() => setUseColor(false));
    afterEach(() => setUseColor(true));

    it("pads short strings with trailing spaces", () => {
        expect(pad("hi", 5)).toBe("hi   ");
    });

    it("returns string unchanged when already >= width", () => {
        expect(pad("hello", 3)).toBe("hello");
        expect(pad("exact", 5)).toBe("exact");
    });

    it("accounts for ANSI codes in width calculation", () => {
        setUseColor(true);
        const colored = c.green("ok");
        const padded = pad(colored, 10);
        // Visible text "ok" is 2 chars, so 8 spaces should be added
        expect(stripAnsi(padded)).toBe("ok        ");
    });
});

describe("rpad — right-pad (left-aligned spaces)", () => {
    beforeEach(() => setUseColor(false));
    afterEach(() => setUseColor(true));

    it("prepends spaces for short strings", () => {
        expect(rpad("hi", 5)).toBe("   hi");
    });

    it("returns string unchanged when already >= width", () => {
        expect(rpad("hello", 3)).toBe("hello");
    });
});

// ---------------------------------------------------------------------------
// renderBar
// ---------------------------------------------------------------------------

describe("renderBar — progress bar rendering", () => {
    beforeEach(() => setUseColor(false));
    afterEach(() => setUseColor(true));

    it("renders full bar at 100%", () => {
        const bar = renderBar(100, 10);
        expect(stripAnsi(bar)).toBe("██████████");
    });

    it("renders empty bar at 0%", () => {
        const bar = renderBar(0, 10);
        expect(stripAnsi(bar)).toBe("░░░░░░░░░░");
    });

    it("renders partial bar at 50%", () => {
        const bar = renderBar(50, 10);
        const text = stripAnsi(bar);
        expect(text).toHaveLength(10);
        expect(text).toContain("█");
        expect(text).toContain("░");
    });

    it("clamps values below 0", () => {
        const bar = renderBar(-10, 10);
        expect(stripAnsi(bar)).toBe("░░░░░░░░░░");
    });

    it("clamps values above 100", () => {
        const bar = renderBar(150, 10);
        expect(stripAnsi(bar)).toBe("██████████");
    });

    it("uses red color for >= 90%", () => {
        setUseColor(true);
        const bar = renderBar(95, 10);
        expect(bar).toContain("\x1b[31m"); // red
    });

    it("uses yellow color for >= 70% and < 90%", () => {
        setUseColor(true);
        const bar = renderBar(75, 10);
        expect(bar).toContain("\x1b[33m"); // yellow
    });

    it("uses green color for < 70%", () => {
        setUseColor(true);
        const bar = renderBar(30, 10);
        expect(bar).toContain("\x1b[32m"); // green
    });

    it("respects custom width", () => {
        const bar = renderBar(50, 20);
        expect(stripAnsi(bar)).toHaveLength(20);
    });
});

// ---------------------------------------------------------------------------
// fmtTokens
// ---------------------------------------------------------------------------

describe("fmtTokens — token count formatting", () => {
    it("formats millions", () => {
        expect(fmtTokens(1_000_000)).toBe("1.0M");
        expect(fmtTokens(2_500_000)).toBe("2.5M");
    });

    it("formats thousands", () => {
        expect(fmtTokens(1_000)).toBe("1.0K");
        expect(fmtTokens(42_300)).toBe("42.3K");
    });

    it("formats small numbers as-is", () => {
        expect(fmtTokens(0)).toBe("0");
        expect(fmtTokens(999)).toBe("999");
    });
});

// ---------------------------------------------------------------------------
// renderUsageLines
// ---------------------------------------------------------------------------

describe("renderUsageLines — usage quota rendering", () => {
    beforeEach(() => setUseColor(false));
    afterEach(() => setUseColor(true));

    it("returns empty array for empty usage object", () => {
        expect(renderUsageLines({})).toEqual([]);
    });

    it("skips buckets without utilization", () => {
        expect(renderUsageLines({ five_hour: {} })).toEqual([]);
        expect(renderUsageLines({ five_hour: { utilization: null } })).toEqual([]);
    });

    it("renders a single bucket line with bar and percentage", () => {
        const lines = renderUsageLines({ five_hour: { utilization: 45 } });
        expect(lines).toHaveLength(1);
        const plain = stripAnsi(lines[0]);
        expect(plain).toContain("5h");
        expect(plain).toContain("45%");
        expect(plain).toContain("█");
    });

    it("renders multiple buckets in order", () => {
        const lines = renderUsageLines({
            five_hour: { utilization: 10 },
            seven_day: { utilization: 70 },
        });
        expect(lines).toHaveLength(2);
        expect(stripAnsi(lines[0])).toContain("5h");
        expect(stripAnsi(lines[1])).toContain("7d");
    });

    it("includes reset time when resets_at is present", () => {
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const lines = renderUsageLines({
            five_hour: { utilization: 50, resets_at: future },
        });
        const plain = stripAnsi(lines[0]);
        expect(plain).toContain("resets in");
    });

    it("skips unknown bucket keys", () => {
        const lines = renderUsageLines({ unknown_bucket: { utilization: 50 } });
        expect(lines).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// QUOTA_BUCKETS / constants
// ---------------------------------------------------------------------------

describe("QUOTA_BUCKETS — bucket definitions", () => {
    it("has expected number of buckets", () => {
        expect(QUOTA_BUCKETS.length).toBeGreaterThanOrEqual(4);
    });

    it("includes five_hour and seven_day", () => {
        const keys = QUOTA_BUCKETS.map((b) => b.key);
        expect(keys).toContain("five_hour");
        expect(keys).toContain("seven_day");
    });
});
