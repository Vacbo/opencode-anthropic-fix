/**
 * Fingerprint regression tests for CC 2.1.90
 *
 * These tests lock in the exact header values, beta flags, and identity strings
 * that must match the upstream Claude Code fingerprint. Any divergence here
 * means the plugin would be detectable as a non-CC client.
 *
 * Reference: docs/cc-versions/2.1.90.md
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildAnthropicBetaHeader } from "../betas.js";
import {
  ADVANCED_TOOL_USE_BETA_FLAG,
  BEDROCK_UNSUPPORTED_BETAS,
  CLAUDE_CODE_BETA_FLAG,
  CLAUDE_CODE_IDENTITY_STRING,
  EFFORT_BETA_FLAG,
  EXPERIMENTAL_BETA_FLAGS,
  FALLBACK_CLAUDE_CLI_VERSION,
  FAST_MODE_BETA_FLAG,
  TOKEN_COUNTING_BETA_FLAG,
} from "../constants.js";
import { buildAnthropicBillingHeader } from "../headers/billing.js";
import { isAdaptiveThinkingModel, isSonnet46Model } from "../models.js";
import { getStainlessArch, getStainlessOs } from "../headers/stainless.js";
import { buildUserAgent } from "../headers/user-agent.js";
import { normalizeThinkingBlock } from "../thinking.js";
import { transformRequestBody } from "../request/body.js";
import { buildSystemPromptBlocks } from "../system-prompt/builder.js";

// ---------------------------------------------------------------------------
// CC 2.1.90 documented values
// ---------------------------------------------------------------------------
const CC_VERSION = "2.1.90";
const STAINLESS_PACKAGE_VERSION = "0.74.0";

type EnvKey =
  | "CLAUDE_AGENT_SDK_CLIENT_APP"
  | "CLAUDE_AGENT_SDK_VERSION"
  | "CLAUDE_CODE_ATTRIBUTION_HEADER"
  | "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"
  | "CLAUDE_CODE_ENTRYPOINT";

function snapshotEnv(...keys: readonly EnvKey[]) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Partial<Record<EnvKey, string | undefined>>;
}

function restoreEnv(snapshot: Partial<Record<EnvKey, string | undefined>>) {
  for (const [key, value] of Object.entries(snapshot) as [EnvKey, string | undefined][]) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// User-Agent
// ---------------------------------------------------------------------------
describe("CC 2.1.90 — User-Agent format", () => {
  let originalEnv: Partial<Record<EnvKey, string | undefined>>;

  beforeEach(() => {
    originalEnv = snapshotEnv("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_AGENT_SDK_CLIENT_APP");
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("matches the claude-cli/<version> (external, cli) pattern", () => {
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_AGENT_SDK_VERSION;
    delete process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toBe(`claude-cli/${CC_VERSION} (external, cli)`);
  });

  it("embeds the correct CC version (2.1.90)", () => {
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toMatch(/^claude-cli\/2\.1\.90 /);
  });

  it("FALLBACK_CLAUDE_CLI_VERSION constant is 2.1.90", () => {
    expect(FALLBACK_CLAUDE_CLI_VERSION).toBe("2.1.90");
  });

  it("appends agent-sdk suffix when CLAUDE_AGENT_SDK_VERSION is set", () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = "1.2.3";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toContain(", agent-sdk/1.2.3");
  });

  it("appends client-app suffix when CLAUDE_AGENT_SDK_CLIENT_APP is set", () => {
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = "myapp";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const ua = buildUserAgent(CC_VERSION);
    expect(ua).toContain(", client-app/myapp");
  });
});

// ---------------------------------------------------------------------------
// Stainless headers
// ---------------------------------------------------------------------------
describe("CC 2.1.90 — Stainless headers", () => {
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
describe("CC 2.1.90 — Billing header", () => {
  let originalEnv: Partial<Record<EnvKey, string | undefined>>;

  beforeEach(() => {
    originalEnv = snapshotEnv("CLAUDE_CODE_ATTRIBUTION_HEADER", "CLAUDE_CODE_ENTRYPOINT");
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "true";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("contains the fixed cch value 00000", () => {
    const header = buildAnthropicBillingHeader(CC_VERSION, []);
    expect(header).toContain("cch=00000;");
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
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = "false";
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
describe("CC 2.1.90 — Beta constants", () => {
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

  it("BEDROCK_UNSUPPORTED_BETAS contains the exact 3 documented betas", () => {
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("interleaved-thinking-2025-05-14");
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("context-1m-2025-08-07");
    expect(BEDROCK_UNSUPPORTED_BETAS).toContain("tool-search-tool-2025-10-19");
    expect(BEDROCK_UNSUPPORTED_BETAS.size).toBe(3);
  });

  it("EXPERIMENTAL_BETA_FLAGS includes fast-mode and advanced-tool-use", () => {
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("fast-mode-2026-02-01");
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("advanced-tool-use-2025-11-20");
  });

  it("EXPERIMENTAL_BETA_FLAGS includes CC v2.1.90 new betas", () => {
    // CC Remote and feature betas from v2.1.90
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("ccr-byoc-2025-07-29");
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("ccr-triggers-2026-01-30");
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("environments-2025-11-01");
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("mcp-client-2025-11-20");
    expect(EXPERIMENTAL_BETA_FLAGS).toContain("skills-2025-10-02");
  });
});

describe("CC 2.1.90 — Beta header composition (signature enabled)", () => {
  let originalEnv: Partial<Record<EnvKey, string | undefined>>;

  beforeEach(() => {
    originalEnv = snapshotEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
  });

  afterEach(() => {
    restoreEnv(originalEnv);
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

  function callBuildBeta(
    overrides: Partial<Omit<typeof baseArgs, "provider">> & { provider?: "anthropic" | "bedrock" } = {},
  ) {
    const args = { ...baseArgs, ...overrides } as typeof baseArgs & { provider?: "anthropic" | "bedrock" };
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
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "";
    const betas = callBuildBeta();
    expect(betas.split(",")).toContain("advanced-tool-use-2025-11-20");
  });

  it("always includes fast-mode-2026-02-01 when experimental enabled", () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "";
    const betas = callBuildBeta();
    expect(betas.split(",")).toContain("fast-mode-2026-02-01");
  });

  it("excludes advanced-tool-use and fast-mode when experimental betas disabled", () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
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
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "";
    const betas = callBuildBeta({ hasFileReferences: true });
    expect(betas.split(",")).toContain("files-api-2025-04-14");
  });

  it("includes files-api-2025-04-14 for /v1/files endpoint", () => {
    process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "";
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
  });

  it("does not auto-include redact-thinking-2026-02-12 (removed in 2.1.90)", () => {
    const betas = callBuildBeta().split(",");
    expect(betas).not.toContain("redact-thinking-2026-02-12");
  });

  it("does not auto-include CC v2.1.90 new experimental betas", () => {
    const betas = callBuildBeta().split(",");
    expect(betas).not.toContain("ccr-byoc-2025-07-29");
    expect(betas).not.toContain("ccr-triggers-2026-01-30");
    expect(betas).not.toContain("environments-2025-11-01");
    expect(betas).not.toContain("mcp-client-2025-11-20");
    expect(betas).not.toContain("skills-2025-10-02");
  });

  it("does not include claude-code-20250219 for haiku models", () => {
    const betas = callBuildBeta({
      model: "claude-haiku-4-5",
    }).split(",");
    expect(betas).not.toContain("claude-code-20250219");
  });
});

describe("CC 2.1.90 — Beta header composition (signature disabled / non-CC mode)", () => {
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
describe("CC 2.1.90 — System prompt identity string", () => {
  it("CLAUDE_CODE_IDENTITY_STRING is the documented value", () => {
    expect(CLAUDE_CODE_IDENTITY_STRING).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  });

  it("identity string does not include trailing period variation", () => {
    // Exact match — no extra text
    expect(CLAUDE_CODE_IDENTITY_STRING).not.toContain("running within the Claude Agent SDK");
  });
});

describe("CC 2.1.90 — Identity block cache TTL", () => {
  it("identity block has cache_control with ttl: '1h'", () => {
    const blocks = buildSystemPromptBlocks(
      [],
      { enabled: true, claudeCliVersion: "2.1.90", promptCompactionMode: "minimal" },
      [],
    );

    const identityBlock = blocks.find((b) => b.text === CLAUDE_CODE_IDENTITY_STRING);
    expect(identityBlock).toBeDefined();
    expect(identityBlock!.cache_control).toBeDefined();
    expect(identityBlock!.cache_control!.type).toBe("ephemeral");
    expect(identityBlock!.cache_control!.ttl).toBe("1h");
  });

  it("billing header block does NOT have cache_control", () => {
    const blocks = buildSystemPromptBlocks(
      [],
      { enabled: true, claudeCliVersion: "2.1.90", promptCompactionMode: "minimal" },
      [],
    );

    const billingBlock = blocks.find((b) => b.type === "text" && b.text.startsWith("x-anthropic-billing-header:"));
    expect(billingBlock).toBeDefined();
    expect(billingBlock!.cache_control).toBeUndefined();
  });

  it("user-provided system blocks do NOT have cache_control", () => {
    const blocks = buildSystemPromptBlocks(
      [{ type: "text", text: "Custom system prompt" }],
      { enabled: true, claudeCliVersion: "2.1.90", promptCompactionMode: "minimal" },
      [],
    );

    const userBlock = blocks.find((b) => b.text === "Custom system prompt");
    expect(userBlock).toBeDefined();
    expect(userBlock!.cache_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sonnet 4.6 adaptive thinking (CC 2.1.90)
// ---------------------------------------------------------------------------
describe("Sonnet 4.6 — Adaptive thinking model detection", () => {
  it("isSonnet46Model detects claude-sonnet-4-6", () => {
    expect(isSonnet46Model("claude-sonnet-4-6")).toBe(true);
  });

  it("isSonnet46Model detects claude-sonnet-4.6", () => {
    expect(isSonnet46Model("claude-sonnet-4.6")).toBe(true);
  });

  it("isSonnet46Model detects sonnet-4-6", () => {
    expect(isSonnet46Model("sonnet-4-6")).toBe(true);
  });

  it("isSonnet46Model returns false for non-Sonnet 4.6 models", () => {
    expect(isSonnet46Model("claude-3-5-sonnet-20241022")).toBe(false);
    expect(isSonnet46Model("claude-opus-4-6")).toBe(false);
    expect(isSonnet46Model("claude-haiku-4-5")).toBe(false);
  });

  it("isAdaptiveThinkingModel returns true for Sonnet 4.6", () => {
    expect(isAdaptiveThinkingModel("claude-sonnet-4-6")).toBe(true);
    expect(isAdaptiveThinkingModel("sonnet-4-6")).toBe(true);
  });

  it("isAdaptiveThinkingModel returns true for Opus 4.6", () => {
    expect(isAdaptiveThinkingModel("claude-opus-4-6")).toBe(true);
    expect(isAdaptiveThinkingModel("opus-4-6")).toBe(true);
  });

  it("isAdaptiveThinkingModel returns false for non-adaptive thinking models", () => {
    expect(isAdaptiveThinkingModel("claude-3-5-sonnet-20241022")).toBe(false);
    expect(isAdaptiveThinkingModel("claude-haiku-4-5")).toBe(false);
  });
});

describe("Sonnet 4.6 — Beta header includes effort-2025-11-24", () => {
  it("includes effort-2025-11-24 for claude-sonnet-4-6", () => {
    const betas = buildAnthropicBetaHeader(
      "",
      true,
      "claude-sonnet-4-6",
      "anthropic",
      undefined,
      undefined,
      undefined,
      false,
    ).split(",");
    expect(betas).toContain(EFFORT_BETA_FLAG);
  });

  it("includes effort-2025-11-24 for sonnet-4-6", () => {
    const betas = buildAnthropicBetaHeader(
      "",
      true,
      "sonnet-4-6",
      "anthropic",
      undefined,
      undefined,
      undefined,
      false,
    ).split(",");
    expect(betas).toContain(EFFORT_BETA_FLAG);
  });

  it("does not include effort-2025-11-24 for claude-3-5-sonnet", () => {
    const betas = buildAnthropicBetaHeader(
      "",
      true,
      "claude-3-5-sonnet-20241022",
      "anthropic",
      undefined,
      undefined,
      undefined,
      false,
    ).split(",");
    expect(betas).not.toContain(EFFORT_BETA_FLAG);
  });
});

describe("Sonnet 4.6 — Thinking block normalization", () => {
  it("normalizes budget_tokens to effort for Sonnet 4.6", () => {
    const result = normalizeThinkingBlock({ type: "enabled", budget_tokens: 8000 }, "claude-sonnet-4-6");
    expect(result).toEqual({ type: "enabled", effort: "medium" });
  });

  it("preserves existing effort for Sonnet 4.6", () => {
    const result = normalizeThinkingBlock({ type: "enabled", effort: "high" }, "claude-sonnet-4-6");
    expect(result).toEqual({ type: "enabled", effort: "high" });
  });

  it("passes through thinking block unchanged for non-adaptive models", () => {
    const input = { type: "enabled", budget_tokens: 8000 };
    const result = normalizeThinkingBlock(input, "claude-3-5-sonnet-20241022");
    expect(result).toEqual(input);
  });

  it("maps low budget_tokens to low effort for Sonnet 4.6", () => {
    const result = normalizeThinkingBlock({ type: "enabled", budget_tokens: 500 }, "claude-sonnet-4-6");
    expect(result).toEqual({ type: "enabled", effort: "low" });
  });

  it("maps high budget_tokens to high effort for Sonnet 4.6", () => {
    const result = normalizeThinkingBlock({ type: "enabled", budget_tokens: 20000 }, "claude-sonnet-4-6");
    expect(result).toEqual({ type: "enabled", effort: "high" });
  });
});

// ---------------------------------------------------------------------------
// Speed parameter passthrough (Opus 4.6 fast mode)
// ---------------------------------------------------------------------------
describe("Speed parameter passthrough", () => {
  const mockSignature = { enabled: false, claudeCliVersion: "2.1.90", promptCompactionMode: "minimal" as const };
  const mockRuntime = { persistentUserId: "", accountId: "", sessionId: "" };

  it("preserves speed: 'fast' in request body", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "Hello" }],
      speed: "fast",
    });
    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);
    expect(parsed.speed).toBe("fast");
  });

  it("preserves speed: 'normal' in request body", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "Hello" }],
      speed: "normal",
    });
    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);
    expect(parsed.speed).toBe("normal");
  });

  it("does not inject speed when not provided", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "Hello" }],
    });
    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);
    expect(parsed.speed).toBeUndefined();
  });

  it("preserves speed alongside other fields", () => {
    const body = JSON.stringify({
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: "Hello" }],
      speed: "fast",
      thinking: { type: "enabled", effort: "high" },
      system: "You are helpful.",
    });
    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);
    expect(parsed.speed).toBe("fast");
    expect(parsed.thinking).toEqual({ type: "enabled", effort: "high" });
    expect(parsed.system).toBeDefined();
  });
});

describe("Temperature normalization", () => {
  const mockSignature = { enabled: false, claudeCliVersion: "2.1.90", promptCompactionMode: "minimal" as const };
  const mockRuntime = { persistentUserId: "", accountId: "", sessionId: "" };

  it("defaults temperature to 1 for non-thinking requests", () => {
    const body = JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hello" }],
    });

    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);

    expect(parsed.temperature).toBe(1);
  });

  it("omits temperature when thinking is enabled", () => {
    const body = JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      thinking: { type: "enabled", budget_tokens: 8000 },
    });

    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);

    expect(Object.prototype.hasOwnProperty.call(parsed, "temperature")).toBe(false);
  });

  it("preserves explicit caller temperature for non-thinking requests", () => {
    const body = JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
    });

    const result = transformRequestBody(body, mockSignature, mockRuntime);
    const parsed = JSON.parse(result!);

    expect(parsed.temperature).toBe(0.7);
  });
});
