/**
 * Billing header edge case tests (Task 10 from quality-refactor plan)
 *
 * Verifies cc_entrypoint uses nullish coalescing (??) not logical OR (||)
 * and handles short/empty messages without crashing.
 */

import { describe, it, expect, afterEach } from "vitest";

import { buildAnthropicBillingHeader } from "../headers/billing.js";

describe("buildAnthropicBillingHeader cc_entrypoint nullish coalescing", () => {
  const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  const originalAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;

  afterEach(() => {
    if (originalEntrypoint === undefined) {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    } else {
      process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint;
    }
    if (originalAttribution === undefined) {
      delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    } else {
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttribution;
    }
  });

  it("defaults to 'cli' when CLAUDE_CODE_ENTRYPOINT is unset", () => {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    const header = buildAnthropicBillingHeader("2.1.98", [{ role: "user", content: "hello" }]);
    expect(header).toContain("cc_entrypoint=cli");
  });

  it("uses explicit value when CLAUDE_CODE_ENTRYPOINT is set to non-empty string", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "slash";
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    const header = buildAnthropicBillingHeader("2.1.98", [{ role: "user", content: "hello" }]);
    expect(header).toContain("cc_entrypoint=slash");
  });

  it("preserves empty string when CLAUDE_CODE_ENTRYPOINT is set to '' (?? not ||)", () => {
    // With logical OR (||), empty string would fall through to "cli".
    // With nullish coalescing (??), empty string is kept as-is.
    process.env.CLAUDE_CODE_ENTRYPOINT = "";
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    const header = buildAnthropicBillingHeader("2.1.98", [{ role: "user", content: "hello" }]);
    expect(header).not.toContain("cc_entrypoint=cli");
  });
});

describe("buildAnthropicBillingHeader version suffix edge cases", () => {
  const originalAttribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;

  afterEach(() => {
    if (originalAttribution === undefined) {
      delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    } else {
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttribution;
    }
  });

  it("handles empty message content without crashing", () => {
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    expect(() => buildAnthropicBillingHeader("2.1.98", [{ role: "user", content: "" }])).not.toThrow();
  });

  it("handles single-character message", () => {
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    expect(() => buildAnthropicBillingHeader("2.1.98", [{ role: "user", content: "x" }])).not.toThrow();
  });

  it("handles empty messages array", () => {
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    expect(() => buildAnthropicBillingHeader("2.1.98", [])).not.toThrow();
  });

  it("includes the CC version in the header output", () => {
    delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    const header = buildAnthropicBillingHeader("2.1.98", [{ role: "user", content: "hello world" }]);
    expect(header).toContain("2.1.98");
  });
});
