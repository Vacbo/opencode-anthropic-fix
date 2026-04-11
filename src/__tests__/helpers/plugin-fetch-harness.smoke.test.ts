/**
 * Smoke test for plugin-fetch-harness.ts
 *
 * Verifies that the harness can:
 * 1. Create a plugin instance with mocked dependencies
 * 2. Fire a request through the fetch interceptor
 * 3. Assert that the request lands on the mock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFetchHarness, setMockAccounts, clearMockAccounts } from "./plugin-fetch-harness.js";

// Mock dependencies (hoisted by Vitest)
vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn().mockResolvedValue("a"),
    close: vi.fn(),
  })),
}));

vi.mock("../../storage.js", () => ({
  createDefaultStats: (now?: number) => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset: now ?? Date.now(),
  }),
  loadAccounts: vi.fn().mockResolvedValue(null),
  saveAccounts: vi.fn().mockResolvedValue(undefined),
  clearAccounts: vi.fn().mockResolvedValue(undefined),
  getStoragePath: vi.fn(() => "/tmp/test-accounts.json"),
}));

vi.mock("../../config.js", () => {
  const DEFAULT_CONFIG = {
    account_selection_strategy: "sticky",
    failure_ttl_seconds: 3600,
    debug: false,
    signature_emulation: {
      enabled: true,
      fetch_claude_code_version_on_startup: false,
      prompt_compaction: "minimal",
    },
    override_model_limits: {
      enabled: false,
      context: 1_000_000,
      output: 0,
    },
    custom_betas: [],
    health_score: {
      initial: 70,
      success_reward: 1,
      rate_limit_penalty: -10,
      failure_penalty: -20,
      recovery_rate_per_hour: 2,
      min_usable: 50,
      max_score: 100,
    },
    token_bucket: {
      max_tokens: 50,
      regeneration_rate_per_minute: 6,
      initial_tokens: 50,
    },
    toasts: {
      quiet: true,
      debounce_seconds: 30,
    },
    headers: {},
    idle_refresh: {
      enabled: false,
      window_minutes: 60,
      min_interval_minutes: 30,
    },
    cc_credential_reuse: {
      enabled: false,
      auto_detect: false,
      prefer_over_oauth: false,
    },
  };

  const createBaseConfig = () => ({
    ...DEFAULT_CONFIG,
    account_selection_strategy: "sticky",
    signature_emulation: {
      ...DEFAULT_CONFIG.signature_emulation,
      fetch_claude_code_version_on_startup: false,
    },
    override_model_limits: {
      ...DEFAULT_CONFIG.override_model_limits,
    },
    custom_betas: [...DEFAULT_CONFIG.custom_betas],
    health_score: { ...DEFAULT_CONFIG.health_score },
    token_bucket: { ...DEFAULT_CONFIG.token_bucket },
    toasts: { ...DEFAULT_CONFIG.toasts },
    headers: { ...DEFAULT_CONFIG.headers },
    idle_refresh: { ...DEFAULT_CONFIG.idle_refresh, enabled: false },
    cc_credential_reuse: { ...DEFAULT_CONFIG.cc_credential_reuse },
  });

  return {
    CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    DEFAULT_CONFIG,
    VALID_STRATEGIES: ["sticky", "round-robin", "hybrid"],
    loadConfig: vi.fn(() => createBaseConfig()),
    loadConfigFresh: vi.fn(() => createBaseConfig()),
    saveConfig: vi.fn(),
    getConfigDir: vi.fn(() => "/tmp/test-config"),
  };
});

vi.mock("../../cc-credentials.js", () => ({
  readCCCredentials: vi.fn(() => []),
}));

vi.mock("../../refresh-lock.js", () => ({
  acquireRefreshLock: vi.fn().mockResolvedValue({
    acquired: true,
    lockPath: "/tmp/opencode-test.lock",
  }),
  releaseRefreshLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@clack/prompts", () => {
  const noop = vi.fn();
  return {
    text: vi.fn().mockResolvedValue(""),
    confirm: vi.fn().mockResolvedValue(false),
    select: vi.fn().mockResolvedValue("cancel"),
    spinner: vi.fn(() => ({ start: noop, stop: noop, message: noop })),
    intro: noop,
    outro: noop,
    isCancel: vi.fn().mockReturnValue(false),
    log: {
      info: noop,
      success: noop,
      warn: noop,
      error: noop,
      message: noop,
      step: noop,
    },
    note: noop,
    cancel: noop,
  };
});

describe("plugin-fetch-harness", () => {
  beforeEach(() => {
    clearMockAccounts();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearMockAccounts();
  });

  it("should create a harness with default options", async () => {
    const harness = await createFetchHarness();

    expect(harness.fetch).toBeDefined();
    expect(harness.mockFetch).toBeDefined();
    expect(harness.tearDown).toBeDefined();
    expect(harness.waitFor).toBeDefined();
    expect(harness.getFetchHeaders).toBeDefined();
    expect(harness.getFetchUrl).toBeDefined();

    harness.tearDown();
  });

  it("should fire a request and land on mock fetch", async () => {
    const harness = await createFetchHarness({
      accounts: [{ email: "test@example.com" }],
      mockResponses: {
        "api.anthropic.com": {
          ok: true,
          status: 200,
          json: async () => ({ id: "msg_123", content: [{ type: "text", text: "Hello" }] }),
        },
      },
    });

    const response = await harness.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet", messages: [{ role: "user", content: "Hi" }] }),
    });

    expect(response.ok).toBe(true);
    expect(harness.mockFetch).toHaveBeenCalledTimes(1);

    const [callUrl] = harness.mockFetch.mock.calls[0] ?? [];
    expect(callUrl).toBeDefined();

    harness.tearDown();
  });

  it("should support multiple accounts", async () => {
    const harness = await createFetchHarness({
      accounts: [
        { email: "alice@example.com", refreshToken: "refresh-alice" },
        { email: "bob@example.com", refreshToken: "refresh-bob" },
      ],
      initialAccount: 1,
    });

    await harness.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(harness.mockFetch).toHaveBeenCalledTimes(1);

    harness.tearDown();
  });

  it("should use custom mock responses", async () => {
    const harness = await createFetchHarness({
      mockResponses: {
        "api.anthropic.com": () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "x-custom-header": "test-value" }),
          json: async () => ({ custom: true }),
        }),
      },
    });

    const response = await harness.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
    });

    const data = await response.json();
    expect(data).toEqual({ custom: true });

    harness.tearDown();
  });

  it("should provide access to request headers", async () => {
    const harness = await createFetchHarness();

    await harness.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "content-type": "application/json",
      },
    });

    const headers = harness.getFetchHeaders(0);
    expect(headers).toBeDefined();

    harness.tearDown();
  });

  it("should support waitFor for async assertions", async () => {
    const harness = await createFetchHarness();

    let callCount = 0;
    harness.mockFetch.mockImplementation(async () => {
      callCount++;
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Fire request asynchronously
    setTimeout(() => {
      harness.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
    }, 50);

    // Wait for the assertion to pass
    await harness.waitFor(() => {
      expect(callCount).toBeGreaterThan(0);
    }, 500);

    harness.tearDown();
  });

  it("should restore original fetch on tearDown", async () => {
    const originalFetch = globalThis.fetch;

    const harness = await createFetchHarness();
    expect(globalThis.fetch).toBe(harness.mockFetch);

    harness.tearDown();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("should handle config overrides", async () => {
    const harness = await createFetchHarness({
      config: {
        debug: true,
        account_selection_strategy: "round-robin",
      },
    });

    expect(harness.fetch).toBeDefined();

    harness.tearDown();
  });
});

describe("setMockAccounts / clearMockAccounts", () => {
  it("should set and clear mock accounts", () => {
    const testAccounts = [
      {
        id: "test-1",
        index: 0,
        refreshToken: "refresh-1",
        access: "access-1",
        expires: Date.now() + 3600_000,
        token_updated_at: Date.now(),
        addedAt: Date.now(),
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
        email: undefined,
        stats: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          lastReset: Date.now(),
        },
        source: "oauth" as const,
      },
    ];

    setMockAccounts(testAccounts, 0);
    clearMockAccounts();
  });
});
