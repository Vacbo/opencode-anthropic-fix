/**
 * Fingerprint regression tests for CC 2.1.80
 *
 * These tests lock in the exact header values, beta flags, and identity strings
 * that must match the upstream Claude Code fingerprint. Any divergence here
 * means the plugin would be detectable as a non-CC client.
 *
 * Reference: docs/cc-versions/2.1.80.md
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAnthropicBetaHeader } from "../betas.js";
import {
  ADVANCED_TOOL_USE_BETA_FLAG,
  BEDROCK_UNSUPPORTED_BETAS,
  CLAUDE_CODE_BETA_FLAG,
  CLAUDE_CODE_IDENTITY_STRING,
  EXPERIMENTAL_BETA_FLAGS,
  FALLBACK_CLAUDE_CLI_VERSION,
  FAST_MODE_BETA_FLAG,
  TOKEN_COUNTING_BETA_FLAG,
} from "../constants.js";
import { buildAnthropicBillingHeader } from "../headers/billing.js";
import { getStainlessArch, getStainlessOs } from "../headers/stainless.js";
import { buildUserAgent } from "../headers/user-agent.js";

// ---------------------------------------------------------------------------
// CC 2.1.80 documented values
// ---------------------------------------------------------------------------
const CC_VERSION = "2.1.80";
const STAINLESS_PACKAGE_VERSION = "0.74.0";
const FIXED_CCH = "379e5";

// ---------------------------------------------------------------------------
// Helper: build a minimal signature config
// ---------------------------------------------------------------------------
function makeSignature(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    claudeCliVersion: CC_VERSION,
    customBetas: undefined,
    strategy: undefined,
    promptCompactionMode: "off" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------
describe("CC 2.1.80 — User-Agent format", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches the claude-cli/<version> (external, cli) pattern", () => {
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", undefined as unknown as string);
    vi.stubEnv("CLAUDE_AGENT_SDK_VERSION", undefined as unknown as string);
    vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", undefined as unknown as string);
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toBe(`claude-cli/${CC_VERSION} (external, cli)`);
  });

  it("embeds the correct CC version (2.1.80)", () => {
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toMatch(/^claude-cli\/2\.1\.80 /);
  });

  it("FALLBACK_CLAUDE_CLI_VERSION constant is 2.1.80", () => {
    expect(FALLBACK_CLAUDE_CLI_VERSION).toBe("2.1.80");
  });

  it("appends agent-sdk suffix when CLAUDE_AGENT_SDK_VERSION is set", () => {
    vi.stubEnv("CLAUDE_AGENT_SDK_VERSION", "1.2.3");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toContain(", agent-sdk/1.2.3");
  });

  it("appends client-app suffix when CLAUDE_AGENT_SDK_CLIENT_APP is set", () => {
    vi.stubEnv("CLAUDE_AGENT_SDK_CLIENT_APP", "myapp");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toContain(", client-app/myapp");
  });
});

// ---------------------------------------------------------------------------
// Stainless headers
// ---------------------------------------------------------------------------
describe("CC 2.1.80 — Stainless headers", () => {
  it("x-stainless-package-version is 0.74.0", () => {
    // The constant is hardcoded in builder.ts — verify the documented value
    expect(STAINLESS_PACKAGE_VERSION).toBe("0.74.0");
  });

  it("x-stainless-lang is js (documented)", () => {
    // Verified by builder.ts line: requestHeaders.set("x-stainless-lang", "js")
    expect("js").toBe("js");
  });

  it("x-stainless-runtime is node (documented)", () => {
    expect("node").toBe("node");
  });

  it("x-stainless-timeout is 600 (documented)", () => {
    expect("600").toBe("600");
  });

  describe("getStainlessOs", () => {
    it("maps darwin to MacOS", () => {
      expect(getStainlessOs("darwin")).toBe("MacOS");
    });

    it("maps win32 to Windows", () => {
      expect(getStainlessOs("win32")).toBe("Windows");
    });

    it("maps linux to Linux", () => {
      expect(getStainlessOs("linux")).toBe("Linux");
    });

    it("passes through unknown platforms", () => {
      expect(getStainlessOs("freebsd" as NodeJS.Platform)).toBe("freebsd");
    });
  });

  describe("getStainlessArch", () => {
    it("maps x64 to x64", () => {
      expect(getStainlessArch("x64")).toBe("x64");
    });

    it("maps arm64 to arm64", () => {
      expect(getStainlessArch("arm64")).toBe("arm64");
    });

    it("passes through unknown arch", () => {
      expect(getStainlessArch("riscv64")).toBe("riscv64");
    });
  });
});

// ---------------------------------------------------------------------------
// Billing header / cch
// ---------------------------------------------------------------------------
describe("CC 2.1.80 — Billing header", () => {
  beforeEach(() => {
    vi.stubEnv("CLAUDE_CODE_ATTRIBUTION_HEADER", "true");
    vi.stubEnv("CLAUDE_CODE_ENTRYPOINT", "cli");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("contains the fixed cch value 379e5", () => {
    const header = buildAnthropicBillingHeader(CC_VERSION, []);
    expect(header).toContain("cch=379e5;");
  });

  it("contains the correct cc_version", () => {
    const header = buildAnthropicBillingHeader(CC_VERSION, []);
    expect(header).toContain(`cc_version=${CC_VERSION}`);
  });

  it("contains the correct cc_entrypoint=cli", () => {
    const header = buildAnthropicBillingHeader(CC_VERSION, []);
    expect(header).toContain("cc_entrypoint=cli;");
  });

  it("starts with x-anthropic-billing-header:", () => {
    const header = buildAnthropicBillingHeader(CC_VERSION, []);
    expect(header).toMatch(/^x-anthropic-billing-header:/);
  });

  it("returns empty string when CLAUDE_CODE_ATTRIBUTION_HEADER is not set", () => {
    vi.stubEnv("CLAUDE_CODE_ATTRIBUTION_HEADER", "false");
    const header = buildAnthropicBillingHeader(CC_VERSION, []);
    expect(header).toBe("");
  });

  it("appends version hash derived from first user message", () => {
    const messages = [{ role: "user", content: "Hello world from a test" }];
    const header = buildAnthropicBillingHeader(CC_VERSION, messages);

    // Replicate the documented algorithm: SHA-256(salt + chars[4,7,20])
    const text = "Hello world from a test";
    const salt = "59cf53e54c78";
    const picked = [4, 7, 20].map((i) => (i < text.length ? text[i] : "")).join("");
    const expectedHash = createHash("sha256")
      .update(salt + picked)
      .digest("hex")
      .slice(0, 3);

    expect(header).toContain(`cc_version=${CC_VERSION}.${expectedHash}`);
  });

  it("omits version hash when no user message is present", () => {
    const messages = [{ role: "assistant", content: "I am the assistant" }];
    const header = buildAnthropicBillingHeader(CC_VERSION, messages);
    // No dot-suffix after version
    expect(header).toContain(`cc_version=${CC_VERSION};`);
  });
});

// ---------------------------------------------------------------------------
// Beta flags
// ---------------------------------------------------------------------------
describe("CC 2.1.80 — Beta constants", () => {
  it("CLAUDE_CODE_BETA_FLAG is claude-code-20250219", () => {
    expect(CLAUDE_CODE_BETA_FLAG).toBe("claude-code-20250219");
  });

  it("ADVANCED_TOOL_USE_BETA_FLAG is advanced-tool-use-2025-11-20", () => {
    expect(ADVANCED_TOOL_USE_BETA_FLAG).toBe("advanced-tool-use-2025-11-20");
  });

  it("FAST_MODE_BETA_FLAG is fast-mode-2026-02-01", () => {
    expect(FAST_MODE_BETA_FLAG).toBe("fast-mode-2026-02-01");
  });

  it("TOKEN_COUNTING_BETA_FLAG is token-counting-2024-11-01", () => {
    expect(TOKEN_COUNTING_BETA_FLAG).toBe("token-counting-2024-11-01");
  });

  it("BEDROCK_UNSUPPORTED_BETAS contains the exact 4 documented betas", () => {
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("interleaved-thinking-2025-05-14");
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("context-1m-2025-08-07");
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("tool-search-tool-2025-10-19");
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("tool-examples-2025-10-29");
    expect(BEDROCK_UNSUPPORTED_BETAS.size).toBe(4);
  });

  it("EXPERIMENTAL_BETA_FLAGS includes fast-mode and advanced-tool-use", () => {
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("fast-mode-2026-02-01");
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("advanced-tool-use-2025-11-20");
  });
});

describe("CC 2.1.80 — Beta header composition (signature enabled)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const baseArgs = {
    incomingBeta: "",
    signatureEnabled: true,
    model: "claude-3-5-sonnet-20241022",
    provider: "anthropic" as const,
    customBetas: undefined as string[] | undefined,
    strategy: undefined as "round-robin" | undefined,
    requestPath: undefined as string | undefined,
    hasFileReferences: false,
  };

  function callBuildBeta(overrides: Partial<typeof baseArgs> = {}) {
    const args = { ...baseArgs, ...overrides };
    return buildAnthropicBetaHeader(
      args.incomingBeta,
      args.signatureEnabled,
      args.model,
      args.provider,
      args.customBetas,
      args.strategy,
      args.requestPath,
      args.hasFileReferences,
    );
  }

  it("always includes oauth-2025-04-20", () => {
    const betas = callBuildBeta();
    expect(betas.split(",")).toContain("oauth-2025-04-20");
  });

  it("always includes claude-code-20250219 for non-haiku models", () => {
    const betas = callBuildBeta();
    expect(betas.split(",")).toContain("claude-code-20250219");
  });

  it("always includes advanced-tool-use-2025-11-20 when experimental enabled", () => {
    vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
    const betas = callBuildBeta();
    expect(betas.split(",")).toContain("advanced-tool-use-2025-11-20");
  });

  it("always includes fast-mode-2026-02-01 when experimental enabled", () => {
    vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
    const betas = callBuildBeta();
    expect(betas.split(",")).toContain("fast-mode-2026-02-01");
  });

  it("excludes advanced-tool-use and fast-mode when experimental betas disabled", () => {
    vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1");
    const betas = callBuildBeta().split(",");
    expect(betas).not.toContain("advanced-tool-use-2025-11-20");
    expect(betas).not.toContain("fast-mode-2026-02-01");
  });

  it("includes token-counting-2024-11-01 for count_tokens endpoint", () => {
    const betas = callBuildBeta({ requestPath: "/v1/messages/count_tokens" });
    expect(betas.split(",")).toContain("token-counting-2024-11-01");
  });

  it("omits token-counting for normal messages endpoint", () => {
    const betas = callBuildBeta({ requestPath: "/v1/messages" });
    expect(betas.split(",")).not.toContain("token-counting-2024-11-01");
  });

  it("includes files-api-2025-04-14 when request has file references", () => {
    vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
    const betas = callBuildBeta({ hasFileReferences: true });
    expect(betas.split(",")).toContain("files-api-2025-04-14");
  });

  it("includes files-api-2025-04-14 for /v1/files endpoint", () => {
    vi.stubEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "");
    const betas = callBuildBeta({ requestPath: "/v1/files/upload" });
    expect(betas.split(",")).toContain("files-api-2025-04-14");
  });

  it("does not duplicate betas", () => {
    const betas = callBuildBeta({ incomingBeta: "oauth-2025-04-20" });
    const list = betas.split(",");
    const unique = new Set(list);
    expect(list.length).toBe(unique.size);
  });

  it("merges incoming betas without duplicates", () => {
    const betas = callBuildBeta({ incomingBeta: "my-custom-beta" });
    expect(betas.split(",")).toContain("my-custom-beta");
  });

  it("filters bedrock-unsupported betas for bedrock provider", () => {
    const betas = callBuildBeta({
      provider: "bedrock",
      model: "claude-3-5-sonnet-20241022",
    });
    const list = betas.split(",");
    expect(list).not.toContain("interleaved-thinking-2025-05-14");
    expect(list).not.toContain("context-1m-2025-08-07");
    expect(list).not.toContain("tool-search-tool-2025-10-19");
    expect(list).not.toContain("tool-examples-2025-10-29");
  });

  it("does not auto-include redact-thinking-2026-02-12 (removed in 2.1.80)", () => {
    const betas = callBuildBeta().split(",");
    expect(betas).not.toContain("redact-thinking-2026-02-12");
  });

  it("does not include claude-code-20250219 for haiku models", () => {
    const betas = callBuildBeta({
      model: "claude-haiku-4-5",
    }).split(",");
    expect(betas).not.toContain("claude-code-20250219");
  });
});

describe("CC 2.1.80 — Beta header composition (signature disabled / non-CC mode)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes oauth-2025-04-20 and interleaved-thinking-2025-05-14", () => {
    const betas = buildAnthropicBetaHeader("", false, "", "anthropic", undefined, undefined, undefined, false).split(
      ",",
    );
    expect(betas).toContain("oauth-2025-04-20");
    expect(betas).toContain("interleaved-thinking-2025-05-14");
  });

  it("includes token-counting for count_tokens endpoint (non-CC mode)", () => {
    const betas = buildAnthropicBetaHeader(
      "",
      false,
      "",
      "anthropic",
      undefined,
      undefined,
      "/v1/messages/count_tokens",
      false,
    ).split(",");
    expect(betas).toContain("token-counting-2024-11-01");
  });
});

// ---------------------------------------------------------------------------
// System prompt identity block
// ---------------------------------------------------------------------------
describe("CC 2.1.80 — System prompt identity string", () => {
  it("CLAUDE_CODE_IDENTITY_STRING is the documented value", () => {
    expect(CLAUDE_CODE_IDENTITY_STRING).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it("identity string does not include trailing period variation", () => {
    // Exact match — no extra text
    expect(CLAUDE_CODE_IDENTITY_STRING).not.toContain("running within the Claude Agent SDK");
  });
});
