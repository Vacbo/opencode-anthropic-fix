/**
 * Plugin Fetch Harness — Reusable test scaffolding for AnthropicAuthPlugin.
 *
 * Provides a clean abstraction for bootstrapping the plugin with mocked
 * dependencies, making it easy to write integration tests that exercise
 * the fetch interceptor, account management, and request transformation.
 *
 * @example
 * ```ts
 * const harness = await createFetchHarness({
 *   accounts: [{ refreshToken: "test-1", email: "test@example.com" }],
 *   mockResponses: { "https://api.anthropic.com/v1/messages": { ok: true, json: async () => ({}) } }
 * });
 *
 * await harness.fetch("https://api.anthropic.com/v1/messages", { method: "POST" });
 * expect(harness.mockFetch).toHaveBeenCalledTimes(1);
 *
 * await harness.tearDown();
 * ```
 */

import { vi, type Mock } from "vitest";
import type { AnthropicAuthConfig } from "../../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of URL patterns to mock Response objects */
export type MockResponseMap = Record<string, Partial<Response> | (() => Partial<Response>)>;

/** Account data structure for harness initialization */
export interface HarnessAccount {
  refreshToken?: string;
  access?: string;
  expires?: number;
  email?: string;
  enabled?: boolean;
}

/** Options for creating a fetch harness */
export interface HarnessOptions {
  /** Account overrides to initialize the harness with (default: single test account) */
  accounts?: HarnessAccount[];
  /** Plugin configuration overrides (default: test-friendly defaults) */
  config?: Partial<AnthropicAuthConfig>;
  /** Mock responses for specific URLs (default: empty) */
  mockResponses?: MockResponseMap;
  /** Initial account index to set as active (default: 0) */
  initialAccount?: number;
}

/** The fetch harness instance returned by createFetchHarness */
export interface FetchHarness {
  /** The fetch interceptor function returned by plugin.auth.loader */
  fetch: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
  /** The mocked global fetch (vi.fn()) — use for assertions */
  mockFetch: Mock;
  /** Cleanup function to restore global state */
  tearDown: () => void;
  /** Helper to wait for an assertion to pass (polling) */
  waitFor: (assertion: () => void, timeoutMs?: number) => Promise<void>;
  /** Get the headers from a specific mock fetch call */
  getFetchHeaders: (callIndex: number) => Headers | undefined;
  /** Get the URL from a specific mock fetch call */
  getFetchUrl: (callIndex: number) => string | Request | undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Default test account factory */
function makeStoredAccount(index: number, overrides: HarnessAccount = {}) {
  const addedAt = Date.now();
  return {
    id: `test-${addedAt}-${index}`,
    index,
    refreshToken: overrides.refreshToken ?? `refresh-${index + 1}`,
    access: overrides.access ?? `access-${index + 1}`,
    expires: overrides.expires ?? Date.now() + 3600_000,
    token_updated_at: addedAt,
    addedAt,
    lastUsed: 0,
    enabled: overrides.enabled ?? true,
    rateLimitResetTimes: {},
    consecutiveFailures: 0,
    lastFailureTime: null,
    email: overrides.email,
    stats: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: addedAt,
    },
    source: "oauth" as const,
  };
}

/** Default mock client factory */
function makeMockClient() {
  return {
    auth: {
      set: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** Default mock provider factory */
function makeMockProvider() {
  return {
    models: {
      "claude-sonnet": {
        id: "claude-sonnet",
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        limit: { context: 200_000, output: 8192 },
      },
      "claude-opus-4-6": {
        id: "claude-opus-4-6",
        cost: { input: 15, output: 75, cache: { read: 1.5, write: 18.75 } },
        limit: { context: 200_000, output: 32_000 },
      },
    },
  };
}

/** Default test configuration */
const DEFAULT_TEST_CONFIG: AnthropicAuthConfig = {
  account_selection_strategy: "sticky",
  failure_ttl_seconds: 3600,
  debug: false,
  signature_emulation: {
    enabled: true,
    fetch_claude_code_version_on_startup: false,
    prompt_compaction: "minimal",
    sanitize_system_prompt: false,
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

// ---------------------------------------------------------------------------
// Module mock state
// ---------------------------------------------------------------------------

let mockAccountsData: {
  version: number;
  accounts: ReturnType<typeof makeStoredAccount>[];
  activeIndex: number;
} | null = null;

/**
 * Set the mock accounts data that will be returned by loadAccounts.
 * Call this before createFetchHarness to pre-seed accounts.
 */
export function setMockAccounts(accounts: ReturnType<typeof makeStoredAccount>[], activeIndex = 0): void {
  mockAccountsData = { version: 1, accounts, activeIndex };
}

/**
 * Clear the mock accounts data.
 */
export function clearMockAccounts(): void {
  mockAccountsData = null;
}

// ---------------------------------------------------------------------------
// Main harness factory
// ---------------------------------------------------------------------------

/**
 * Creates a fetch harness for testing the AnthropicAuthPlugin.
 *
 * This function bootstraps the plugin with mocked dependencies and returns
 * a harness object containing the fetch interceptor and utilities for
 * assertions and cleanup.
 *
 * IMPORTANT: This function must be called AFTER vi.mock() declarations
 * at the top of your test file. The mocks are hoisted by Vitest.
 *
 * @param opts - Configuration options for the harness
 * @returns A FetchHarness instance ready for testing
 */
export async function createFetchHarness(opts: HarnessOptions = {}): Promise<FetchHarness> {
  const { accounts = [{}], config = {}, mockResponses = {}, initialAccount = 0 } = opts;

  // Merge config with defaults
  const mergedConfig: AnthropicAuthConfig = {
    ...DEFAULT_TEST_CONFIG,
    ...config,
    signature_emulation: {
      ...DEFAULT_TEST_CONFIG.signature_emulation,
      ...config.signature_emulation,
    },
    health_score: { ...DEFAULT_TEST_CONFIG.health_score, ...config.health_score },
    token_bucket: { ...DEFAULT_TEST_CONFIG.token_bucket, ...config.token_bucket },
    toasts: { ...DEFAULT_TEST_CONFIG.toasts, ...config.toasts },
    override_model_limits: {
      ...DEFAULT_TEST_CONFIG.override_model_limits,
      ...config.override_model_limits,
    },
    idle_refresh: { ...DEFAULT_TEST_CONFIG.idle_refresh, ...config.idle_refresh },
    cc_credential_reuse: { ...DEFAULT_TEST_CONFIG.cc_credential_reuse, ...config.cc_credential_reuse },
  };

  // Create mock client
  const client = makeMockClient();

  // Store original fetch and create mock
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn();

  // Set up mock response handler
  mockFetch.mockImplementation((input: string | Request | URL) => {
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      url = input.url;
    }

    // Check for matching mock response
    for (const [pattern, response] of Object.entries(mockResponses)) {
      if (url && url.includes(pattern)) {
        const responseObj = typeof response === "function" ? response() : response;
        if (responseObj instanceof Response) {
          return Promise.resolve(responseObj);
        }

        if (typeof responseObj.json === "function") {
          return responseObj.json().then(
            (jsonBody) =>
              new Response(JSON.stringify(jsonBody), {
                status: responseObj.status ?? 200,
                statusText: responseObj.statusText ?? "OK",
                headers:
                  responseObj.headers instanceof Headers
                    ? responseObj.headers
                    : new Headers(responseObj.headers ?? { "content-type": "application/json" }),
              }),
          );
        }

        if (typeof responseObj.text === "function") {
          return responseObj.text().then(
            (textBody) =>
              new Response(textBody, {
                status: responseObj.status ?? 200,
                statusText: responseObj.statusText ?? "OK",
                headers:
                  responseObj.headers instanceof Headers
                    ? responseObj.headers
                    : new Headers(responseObj.headers ?? undefined),
              }),
          );
        }

        return Promise.resolve(
          new Response(undefined, {
            status: responseObj.status ?? 200,
            statusText: responseObj.statusText ?? "OK",
            headers:
              responseObj.headers instanceof Headers
                ? responseObj.headers
                : new Headers(responseObj.headers ?? undefined),
          }),
        );
      }
    }

    // Default: return empty successful response
    return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  });

  // Install mock
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

  // Build accounts data
  const managedAccounts = accounts.map((overrides, index) => makeStoredAccount(index, overrides));

  // Pre-seed mock accounts
  mockAccountsData = { version: 1, accounts: managedAccounts, activeIndex: initialAccount };

  // Dynamically import modules to get mocked versions
  const { AnthropicAuthPlugin } = await import("../../index.js");
  const { loadConfig, loadConfigFresh } = await import("../../config.js");
  const { loadAccounts } = await import("../../storage.js");

  // Override config mock to return our merged config
  vi.mocked(loadConfig).mockReturnValue(mergedConfig);
  vi.mocked(loadConfigFresh).mockReturnValue(mergedConfig);
  vi.mocked(loadAccounts).mockResolvedValue(mockAccountsData);

  // Initialize plugin
  const plugin = await AnthropicAuthPlugin({ client });

  // Create mock auth getter
  const getAuth = vi.fn().mockResolvedValue({
    type: "oauth",
    refresh: managedAccounts[initialAccount]?.refreshToken ?? "refresh-1",
    access: managedAccounts[initialAccount]?.access ?? "access-1",
    expires: Date.now() + 3600_000,
  });

  // Initialize the plugin's auth loader
  const provider = makeMockProvider();
  const result = await plugin.auth.loader(getAuth, provider);

  // Helper: wait for assertion
  async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
    const started = Date.now();
    while (true) {
      try {
        assertion();
        return;
      } catch (err) {
        if (Date.now() - started >= timeoutMs) throw err;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  // Helper: get fetch headers
  function getFetchHeaders(callIndex: number): Headers | undefined {
    const [input, init] = mockFetch.mock.calls[callIndex] ?? [];
    if (init?.headers) {
      return init.headers instanceof Headers ? init.headers : new Headers(init.headers);
    }
    if (input instanceof Request) {
      return input.headers;
    }
    return undefined;
  }

  // Helper: get fetch URL
  function getFetchUrl(callIndex: number): string | Request | undefined {
    const [input] = mockFetch.mock.calls[callIndex] ?? [];
    return input;
  }

  // Cleanup function
  function tearDown(): void {
    globalThis.fetch = originalFetch;
    clearMockAccounts();
  }

  if (!result.fetch) {
    throw new Error("Plugin did not return a fetch function");
  }

  return {
    fetch: result.fetch,
    mockFetch,
    tearDown,
    waitFor,
    getFetchHeaders,
    getFetchUrl,
  };
}
