/**
 * Tests for the CLI account management tool.
 *
 * We mock storage and config to control what the CLI sees,
 * and capture console output to verify formatting.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./src/storage.js", () => ({
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
  getStoragePath: vi.fn(() => "/home/user/.config/opencode/anthropic-accounts.json"),
}));

vi.mock("./src/config.js", () => {
  const DEFAULT_CONFIG = {
    account_selection_strategy: "sticky",
    failure_ttl_seconds: 3600,
    debug: false,
    signature_emulation: {
      enabled: true,
      fetch_claude_code_version_on_startup: true,
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
      quiet: false,
      debounce_seconds: 30,
    },
    headers: {},
    idle_refresh: {
      enabled: true,
      window_minutes: 60,
      min_interval_minutes: 30,
    },
  };

  const createDefaultConfig = () => ({
    ...DEFAULT_CONFIG,
    signature_emulation: { ...DEFAULT_CONFIG.signature_emulation },
    override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
    custom_betas: [...DEFAULT_CONFIG.custom_betas],
    health_score: { ...DEFAULT_CONFIG.health_score },
    token_bucket: { ...DEFAULT_CONFIG.token_bucket },
    toasts: { ...DEFAULT_CONFIG.toasts },
    headers: { ...DEFAULT_CONFIG.headers },
    idle_refresh: { ...DEFAULT_CONFIG.idle_refresh },
  });

  return {
    CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    DEFAULT_CONFIG,
    VALID_STRATEGIES: ["sticky", "round-robin", "hybrid"],
    loadConfig: vi.fn(() => createDefaultConfig()),
    saveConfig: vi.fn(),
    getConfigPath: vi.fn(() => "/home/user/.config/opencode/anthropic-auth.json"),
    getConfigDir: vi.fn(() => "/home/user/.config/opencode"),
  };
});

vi.mock("./src/oauth.js", () => ({
  authorize: vi.fn(async () => ({
    url: "https://auth.example/authorize",
    verifier: "pkce-verifier",
  })),
  exchange: vi.fn(async () => ({
    type: "success",
    refresh: "refresh-new",
    access: "access-new",
    expires: Date.now() + 3600_000,
    email: "new@example.com",
  })),
  revoke: vi.fn(async () => true),
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Mock @clack/prompts for interactive commands
vi.mock("@clack/prompts", () => {
  const mockText = vi.fn().mockResolvedValue("n");
  const mockConfirm = vi.fn().mockResolvedValue(false);
  const mockSelect = vi.fn().mockResolvedValue("cancel");
  const mockSpinner = vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  }));
  const mockIntro = vi.fn();
  const mockOutro = vi.fn();
  const mockIsCancel = vi.fn().mockReturnValue(false);
  const mockLog = {
    info: vi.fn((message?: string) => console.log(message ?? "")),
    success: vi.fn((message?: string) => console.log(message ?? "")),
    warn: vi.fn((message?: string) => console.log(message ?? "")),
    error: vi.fn((message?: string) => console.error(message ?? "")),
    message: vi.fn((message?: string) => console.log(message ?? "")),
    step: vi.fn((message?: string) => console.log(message ?? "")),
  };
  const mockNote = vi.fn((message?: string, title?: string) =>
    console.log(title ? `${title}\n${message ?? ""}` : (message ?? "")),
  );
  const mockCancel = vi.fn((message?: string) => console.log(message ?? ""));

  return {
    text: mockText,
    confirm: mockConfirm,
    select: mockSelect,
    spinner: mockSpinner,
    intro: mockIntro,
    outro: mockOutro,
    isCancel: mockIsCancel,
    log: mockLog,
    note: mockNote,
    cancel: mockCancel,
  };
});

import { exec } from "node:child_process";
import { text, confirm, select, spinner, isCancel, log, note } from "@clack/prompts";
import {
  cmdConfig,
  cmdDisable,
  cmdEnable,
  cmdHelp,
  cmdList,
  cmdLogin,
  cmdLogout,
  cmdManage,
  cmdReauth,
  cmdRefresh,
  cmdRemove,
  cmdReset,
  cmdResetStats,
  cmdStats,
  cmdStatus,
  cmdStrategy,
  cmdSwitch,
  ensureTokenAndFetchUsage,
  fetchUsage,
  formatDuration,
  formatResetTime,
  formatTimeAgo,
  main,
  refreshAccessToken,
  renderBar,
  renderUsageLines,
} from "./src/cli.js";
import { authorize, exchange, revoke } from "./src/oauth.js";
import { loadAccounts, saveAccounts } from "./src/storage.js";

// ---------------------------------------------------------------------------
// Global fetch mock — prevents real HTTP calls and speeds up tests
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;
const mockText = text as Mock;
const mockConfirm = confirm as Mock;
const mockSelect = select as Mock;
const mockIsCancel = isCancel as unknown as Mock;
const mockSpinner = spinner as Mock;
const mockAuthorize = authorize as Mock;
const mockExchange = exchange as Mock;
const mockRevoke = revoke as Mock;
const mockLoadAccounts = loadAccounts as Mock;
const mockSaveAccounts = saveAccounts as Mock;
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = new RegExp("\\x1b\\[[0-9;]*m", "g");

beforeEach(() => {
  globalThis.fetch = mockFetch as typeof fetch;
  mockFetch.mockReset();
  // Default: all fetches fail gracefully (usage endpoints return null)
  mockFetch.mockResolvedValue({ ok: false, status: 500 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture console.log and console.error output */
function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  return {
    logs,
    errors,
    /** Get all log output as a single string (ANSI stripped) */
    text: () => logs.join("\n").replace(ANSI_REGEX, ""),
    /** Get all error output as a single string (ANSI stripped) */
    errorText: () => errors.join("\n").replace(ANSI_REGEX, ""),
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

/** Temporarily set process.stdin.isTTY for interactive command tests. */
function setStdinTTY(value) {
  const stdinWithTTY = process.stdin as typeof process.stdin & { isTTY?: boolean };
  const previous = stdinWithTTY.isTTY;
  stdinWithTTY.isTTY = value;
  return () => {
    if (typeof previous === "undefined") {
      stdinWithTTY.isTTY = undefined as unknown as boolean;
    } else {
      stdinWithTTY.isTTY = previous;
    }
  };
}

function mockReadlineAnswer(answer: string) {
  mockText.mockResolvedValueOnce(answer);
}

function mockConfirmAnswer(value: boolean) {
  mockConfirm.mockResolvedValueOnce(value);
}

function _mockSelectAnswer(value: string) {
  mockSelect.mockResolvedValueOnce(value);
}

/** Collect all @clack/prompts log.* mock call text (ANSI stripped) */
function clackText() {
  const calls = [
    ...(log.info as Mock).mock.calls,
    ...(log.success as Mock).mock.calls,
    ...(log.warn as Mock).mock.calls,
    ...(log.error as Mock).mock.calls,
    ...(log.message as Mock).mock.calls,
  ];
  return calls
    .map((c) => String(c[0]))
    .join("\n")
    .replace(ANSI_REGEX, "");
}

/** Make a standard test account storage object */
function makeStorage(overrides: Record<string, any> = {}): any {
  return {
    version: 1,
    accounts: [
      {
        email: "alice@example.com",
        refreshToken: "refresh-alice",
        addedAt: 1000,
        lastUsed: 5000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
      {
        refreshToken: "refresh-bob",
        addedAt: 2000,
        lastUsed: 3000,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
      {
        email: "charlie@example.com",
        refreshToken: "refresh-charlie",
        addedAt: 3000,
        lastUsed: 1000,
        enabled: false,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      },
    ],
    activeIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("returns 'now' for zero or negative", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(-100)).toBe("now");
  });

  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  it("formats long durations as days", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
    expect(formatDuration(112 * 3_600_000)).toBe("4d 16h");
  });
});

describe("formatTimeAgo", () => {
  it("returns 'never' for zero or falsy", () => {
    expect(formatTimeAgo(0)).toBe("never");
    expect(formatTimeAgo(null)).toBe("never");
    expect(formatTimeAgo(undefined)).toBe("never");
  });

  it("returns relative time for past timestamps", () => {
    const fiveMinAgo = Date.now() - 300_000;
    expect(formatTimeAgo(fiveMinAgo)).toBe("5m ago");
  });

  it("returns 'just now' for future timestamps", () => {
    expect(formatTimeAgo(Date.now() + 10_000)).toBe("just now");
  });
});

/** Strip ANSI escape codes for test assertions. */
function stripAnsi(str) {
  return str.replace(ANSI_REGEX, "");
}

// ---------------------------------------------------------------------------
// Usage formatting helpers
// ---------------------------------------------------------------------------

describe("renderBar", () => {
  it("renders empty bar at 0%", () => {
    const bar = stripAnsi(renderBar(0, 10));
    expect(bar).toBe("░".repeat(10));
  });

  it("renders full bar at 100%", () => {
    const bar = stripAnsi(renderBar(100, 10));
    expect(bar).toBe("█".repeat(10));
  });

  it("renders proportional fill at 50%", () => {
    const bar = stripAnsi(renderBar(50, 10));
    expect(bar).toBe("█████░░░░░");
  });

  it("clamps above 100%", () => {
    const bar = stripAnsi(renderBar(150, 10));
    expect(bar).toBe("█".repeat(10));
  });

  it("clamps below 0%", () => {
    const bar = stripAnsi(renderBar(-10, 10));
    expect(bar).toBe("░".repeat(10));
  });
});

describe("formatResetTime", () => {
  it("returns relative duration for future timestamps", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(formatResetTime(future)).toMatch(/59m|1h/);
  });

  it("returns 'now' for past timestamps", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(formatResetTime(past)).toBe("now");
  });
});

describe("renderUsageLines", () => {
  it("renders lines for non-null buckets only", () => {
    const usage = {
      five_hour: {
        utilization: 10.0,
        resets_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      seven_day: {
        utilization: 67.0,
        resets_at: new Date(Date.now() + 86400_000).toISOString(),
      },
      seven_day_sonnet: null,
      seven_day_opus: null,
    };
    const lines = renderUsageLines(usage);
    expect(lines).toHaveLength(2);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("5h");
    expect(text).toContain("10%");
    expect(text).toContain("7d");
    expect(text).toContain("67%");
  });

  it("returns empty array when all buckets are null", () => {
    const usage = { five_hour: null, seven_day: null };
    expect(renderUsageLines(usage)).toHaveLength(0);
  });

  it("includes model-specific buckets when present", () => {
    const usage = {
      five_hour: {
        utilization: 5.0,
        resets_at: new Date(Date.now() + 1000).toISOString(),
      },
      seven_day: {
        utilization: 30.0,
        resets_at: new Date(Date.now() + 1000).toISOString(),
      },
      seven_day_sonnet: {
        utilization: 11.0,
        resets_at: new Date(Date.now() + 1000).toISOString(),
      },
      seven_day_opus: {
        utilization: 22.0,
        resets_at: new Date(Date.now() + 1000).toISOString(),
      },
    };
    const lines = renderUsageLines(usage);
    expect(lines).toHaveLength(4);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("Sonnet 7d");
    expect(text).toContain("11%");
    expect(text).toContain("Opus 7d");
    expect(text).toContain("22%");
  });
});

// ---------------------------------------------------------------------------
// Usage fetch helpers
// ---------------------------------------------------------------------------

describe("refreshAccessToken", () => {
  it("refreshes token and updates account object", async () => {
    const account = {
      refreshToken: "old-refresh",
      access: undefined,
      expires: undefined,
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });

    const token = await refreshAccessToken(account);
    expect(token).toBe("new-access");
    expect(account.access).toBe("new-access");
    expect(account.refreshToken).toBe("new-refresh");
    expect(account.expires).toBeGreaterThan(Date.now());
  });

  it("returns null on failure", async () => {
    const account = { refreshToken: "bad-refresh" };
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const token = await refreshAccessToken(account);
    expect(token).toBeNull();
  });

  it("returns null on network error", async () => {
    const account = { refreshToken: "refresh" };
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    const token = await refreshAccessToken(account);
    expect(token).toBeNull();
  });
});

describe("fetchUsage", () => {
  it("returns usage data on success", async () => {
    const usageData = {
      five_hour: { utilization: 10.0, resets_at: "2026-02-07T06:00:00Z" },
      seven_day: { utilization: 67.0, resets_at: "2026-02-08T01:00:00Z" },
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => usageData,
    });

    const result = await fetchUsage("valid-token");
    expect(result).toEqual(usageData);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(opts.headers.authorization).toBe("Bearer valid-token");
    expect(opts.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("returns null on failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    expect(await fetchUsage("bad-token")).toBeNull();
  });
});

describe("ensureTokenAndFetchUsage", () => {
  it("skips disabled accounts", async () => {
    const result = await ensureTokenAndFetchUsage({
      enabled: false,
      refreshToken: "x",
    });
    expect(result).toEqual({ usage: null, tokenRefreshed: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses existing valid token without refreshing", async () => {
    const account = {
      enabled: true,
      refreshToken: "refresh",
      access: "valid-access",
      expires: Date.now() + 3600_000,
    };
    const usageData = {
      five_hour: { utilization: 5.0, resets_at: "2026-01-01T00:00:00Z" },
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => usageData });

    const result = await ensureTokenAndFetchUsage(account);
    expect(result.usage).toEqual(usageData);
    expect(result.tokenRefreshed).toBe(false);
    // Only 1 fetch call (usage), no token refresh
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes expired token before fetching usage", async () => {
    const account = {
      enabled: true,
      refreshToken: "refresh",
      access: "expired-access",
      expires: Date.now() - 1000, // expired
    };
    // First call: token refresh
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    });
    // Second call: usage fetch
    const usageData = {
      five_hour: { utilization: 20.0, resets_at: "2026-01-01T00:00:00Z" },
    };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => usageData });

    const result = await ensureTokenAndFetchUsage(account);
    expect(result.usage).toEqual(usageData);
    expect(result.tokenRefreshed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null usage when token refresh fails", async () => {
    const account = {
      enabled: true,
      refreshToken: "bad-refresh",
      access: undefined,
      expires: undefined,
    };
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await ensureTokenAndFetchUsage(account);
    expect(result.usage).toBeNull();
    expect(result.tokenRefreshed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cmdList
// ---------------------------------------------------------------------------

/** Helper to mock usage fetch for cmdList tests. */
function mockUsageForAccounts(...usages) {
  const queue = [...usages];
  const usageByToken = new Map();
  let tokenCounter = 0;

  mockFetch.mockImplementation((url, opts = {}) => {
    const target = String(url);

    if (target.includes("/v1/oauth/token")) {
      if (queue.length === 0) return Promise.resolve({ ok: false, status: 500 });

      const usage = queue.shift();
      if (usage === null) {
        return Promise.resolve({ ok: false, status: 401 });
      }

      tokenCounter += 1;
      const token = `access-${tokenCounter}`;
      usageByToken.set(token, usage);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          access_token: token,
          refresh_token: `refresh-${tokenCounter}`,
          expires_in: 3600,
        }),
      });
    }

    if (target.includes("/api/oauth/usage")) {
      const auth = opts.headers?.authorization || opts.headers?.Authorization;
      const token = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";

      if (!usageByToken.has(token)) {
        return Promise.resolve({ ok: false, status: 401 });
      }

      const usage = usageByToken.get(token);
      return Promise.resolve({ ok: true, json: async () => usage });
    }

    return Promise.resolve({ ok: false, status: 500 });
  });
}

describe("cmdList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
    mockSpinner.mockReturnValue({ start: vi.fn(), stop: vi.fn(), message: vi.fn() });
  });

  it("shows 'no accounts' message when storage is empty", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdList();
    expect(code).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("No accounts configured"));
  });

  it("displays account table with correct columns", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdList();
    expect(code).toBe(0);

    const text = clackText();
    expect(text).toContain("Anthropic Multi-Account Status");
    expect(text).toContain("alice@example.com");
    expect(text).toContain("Account 2");
    expect(text).toContain("charlie@example.com");
    expect(text).toContain("active");
    expect(text).toContain("ready");
    expect(text).toContain("disabled");
  });

  it("shows enabled/disabled counts", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdList();
    expect(code).toBe(0);

    const text = clackText();
    expect(text).toContain("2 of 3 enabled");
    expect(text).toContain("1 disabled");
  });

  it("shows rate limit countdown for rate-limited accounts", async () => {
    const storage = makeStorage();
    storage.accounts[1].rateLimitResetTimes = {
      anthropic: Date.now() + 150_000,
    };
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdList();
    expect(code).toBe(0);

    const text = clackText();
    expect(text).toMatch(/2m\s+(29|30)s/);
  });

  it("shows consecutive failure count", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 5;
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdList();
    expect(code).toBe(0);
    expect(clackText()).toContain("5");
  });

  it("shows strategy name", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdList();
    expect(code).toBe(0);
    expect(clackText()).toContain("sticky");
  });

  it("uses spinner while fetching quotas", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    await cmdList();
    expect(spinner).toHaveBeenCalled();
    const s = mockSpinner.mock.results[0].value;
    expect(s.start).toHaveBeenCalledWith(expect.stringContaining("Fetching"));
    expect(s.stop).toHaveBeenCalled();
  });

  it("shows live usage quotas for enabled accounts", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const usage = {
      five_hour: {
        utilization: 9.0,
        resets_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      seven_day: {
        utilization: 67.0,
        resets_at: new Date(Date.now() + 86400_000).toISOString(),
      },
      seven_day_sonnet: {
        utilization: 11.0,
        resets_at: new Date(Date.now() + 172800_000).toISOString(),
      },
      seven_day_opus: null,
    };
    // Only 2 enabled accounts need mocking (account 3 is disabled, skips fetch)
    mockUsageForAccounts(usage, usage);

    const code = await cmdList();
    expect(code).toBe(0);

    const text = clackText();
    expect(text).toContain("5h");
    expect(text).toContain("9%");
    expect(text).toContain("7d");
    expect(text).toContain("67%");
    expect(text).toContain("Sonnet 7d");
    expect(text).toContain("11%");
    // Opus 7d should NOT appear (null)
    expect(text).not.toContain("Opus 7d");
  });

  it("shows 'quotas: unavailable' when usage fetch fails", async () => {
    const storage = makeStorage();
    storage.accounts[2].enabled = true; // enable all 3
    mockLoadAccounts.mockResolvedValue(storage);
    // All three accounts: token refresh fails
    mockUsageForAccounts(null, null, null);

    const code = await cmdList();
    expect(code).toBe(0);
    expect(clackText()).toContain("quotas: unavailable");
  });

  it("does not show quota lines for disabled accounts", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    // Account 1 and 2 (enabled) get usage; account 3 is disabled and skips fetch entirely
    mockUsageForAccounts(
      {
        five_hour: {
          utilization: 5.0,
          resets_at: new Date(Date.now() + 1000).toISOString(),
        },
      },
      {
        five_hour: {
          utilization: 15.0,
          resets_at: new Date(Date.now() + 1000).toISOString(),
        },
      },
    );

    const code = await cmdList();
    expect(code).toBe(0);
    const text = clackText();
    // Should see quota lines for enabled accounts
    expect(text).toContain("5%");
    expect(text).toContain("15%");
    // Disabled account (charlie) should not have quota lines — just the status row
    const lines = text.split("\n");
    const charlieIdx = lines.findIndex((l) => l.includes("charlie@example.com"));
    expect(charlieIdx).toBeGreaterThan(-1);
    // Next line after charlie should NOT be a quota line
    const nextLine = lines[charlieIdx + 1] || "";
    expect(nextLine).not.toContain("5h");
    expect(nextLine).not.toContain("quotas:");
  });

  it("persists refreshed tokens back to disk", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    mockSaveAccounts.mockResolvedValue(undefined);
    // Only 2 enabled accounts need mocking (account 3 is disabled)
    mockUsageForAccounts(
      {
        five_hour: {
          utilization: 1.0,
          resets_at: new Date(Date.now() + 1000).toISOString(),
        },
      },
      {
        five_hour: {
          utilization: 2.0,
          resets_at: new Date(Date.now() + 1000).toISOString(),
        },
      },
    );

    await cmdList();
    // saveAccounts should be called to persist the refreshed tokens
    expect(saveAccounts).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

describe("cmdStatus", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it("shows 'no accounts' for empty storage", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdStatus();
    expect(code).toBe(1);
    expect(output.text()).toContain("no accounts configured");
  });

  it("shows compact one-liner with account count", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdStatus();
    expect(code).toBe(0);

    const text = output.text();
    expect(text).toContain("anthropic:");
    expect(text).toContain("3 accounts");
    expect(text).toContain("2 active");
    expect(text).toContain("strategy: sticky");
    expect(text).toContain("next: #1");
  });

  it("includes rate-limited count when accounts are rate-limited", async () => {
    const storage = makeStorage();
    storage.accounts[0].rateLimitResetTimes = {
      anthropic: Date.now() + 60_000,
    };
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdStatus();
    expect(code).toBe(0);
    expect(output.text()).toContain("1 rate-limited");
  });
});

// ---------------------------------------------------------------------------
// cmdSwitch
// ---------------------------------------------------------------------------

describe("cmdSwitch", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("switches active account", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdSwitch("2");
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Switched"));

    // Verify saveAccounts was called with updated activeIndex
    expect(saveAccounts).toHaveBeenCalledWith(expect.objectContaining({ activeIndex: 1 }));
  });

  it("rejects invalid account number", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdSwitch("99");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });

  it("rejects switching to disabled account", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdSwitch("3");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("rejects non-numeric input", async () => {
    const code = await cmdSwitch("abc");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("valid account number"));
  });

  it("rejects when no accounts exist", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdSwitch("1");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("no accounts"));
  });
});

// ---------------------------------------------------------------------------
// cmdEnable
// ---------------------------------------------------------------------------

describe("cmdEnable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  it("enables a disabled account", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdEnable("3");
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Enabled"));
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("charlie@example.com"));

    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({
            email: "charlie@example.com",
            enabled: true,
          }),
        ]),
      }),
    );
  });

  it("is a no-op for already enabled account", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdEnable("1");
    expect(code).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already enabled"));
    expect(saveAccounts).not.toHaveBeenCalled();
  });

  it("rejects invalid account number", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdEnable("99");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });
});

// ---------------------------------------------------------------------------
// cmdDisable
// ---------------------------------------------------------------------------

describe("cmdDisable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  it("disables an enabled account", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdDisable("2");
    expect(code).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Disabled"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Account 2"));
  });

  it("is a no-op for already disabled account", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdDisable("3");
    expect(code).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("already disabled"));
  });

  it("prevents disabling the last enabled account", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdDisable("1");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("last enabled"));
  });

  it("switches active account when disabling the active one (single atomic save)", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdDisable("1"); // alice is active
    expect(code).toBe(0);

    // Should save exactly once (disable + activeIndex adjustment in one write)
    expect(saveAccounts).toHaveBeenCalledTimes(1);
    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].enabled).toBe(false);
    expect(saved.activeIndex).toBe(1); // switched to bob (next enabled)
  });
});

// ---------------------------------------------------------------------------
// Auth commands
// ---------------------------------------------------------------------------

describe("auth commands", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
    mockSpinner.mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    });
    mockSaveAccounts.mockResolvedValue(undefined);
    mockLoadAccounts.mockResolvedValue(makeStorage());
    mockAuthorize.mockResolvedValue({
      url: "https://auth.example/authorize",
      verifier: "pkce-verifier",
    });
    mockExchange.mockResolvedValue({
      type: "success",
      refresh: "refresh-new",
      access: "access-new",
      expires: Date.now() + 3600_000,
      email: "new@example.com",
    });
    mockRevoke.mockResolvedValue(true);
  });

  afterEach(() => {
    output.restore();
  });

  it("cmdLogin rejects non-interactive terminals", async () => {
    const restoreTTY = setStdinTTY(false);
    try {
      const code = await cmdLogin();
      expect(code).toBe(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("requires an interactive terminal"));
      expect(authorize).not.toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogin adds a new account via OAuth", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");

    try {
      const code = await cmdLogin();
      expect(code).toBe(0);
      expect(authorize).toHaveBeenCalledWith("max");
      expect(exchange).toHaveBeenCalledWith("auth-code#state", "pkce-verifier");
      expect(exec).toHaveBeenCalled();
      expect(saveAccounts).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 1,
          activeIndex: 0,
          accounts: expect.arrayContaining([
            expect.objectContaining({
              refreshToken: "refresh-new",
              access: "access-new",
              enabled: true,
              email: "new@example.com",
            }),
          ]),
        }),
      );
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogin updates duplicate account even when at max capacity", async () => {
    const fullStorage = {
      version: 1,
      activeIndex: 0,
      accounts: Array.from({ length: 10 }, (_, i) => ({
        refreshToken: i === 4 ? "refresh-new" : `refresh-${i}`,
        access: `access-${i}`,
        expires: Date.now() + 1000,
        addedAt: 1000 + i,
        lastUsed: 0,
        enabled: i === 4 ? false : true,
        rateLimitResetTimes: {},
        consecutiveFailures: 2,
        lastFailureTime: Date.now(),
      })),
    };
    mockLoadAccounts.mockResolvedValue(fullStorage);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");

    try {
      const code = await cmdLogin();
      expect(code).toBe(0);
      const saved = mockSaveAccounts.mock.calls[0][0];
      expect(saved.accounts).toHaveLength(10);
      expect(saved.accounts[4].refreshToken).toBe("refresh-new");
      expect(saved.accounts[4].access).toBe("access-new");
      expect(saved.accounts[4].enabled).toBe(true);
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogin rejects adding new account when at max capacity", async () => {
    const fullStorage = {
      version: 1,
      activeIndex: 0,
      accounts: Array.from({ length: 10 }, (_, i) => ({
        refreshToken: `refresh-${i}`,
        access: `access-${i}`,
        expires: Date.now() + 1000,
        addedAt: 1000 + i,
        lastUsed: 0,
        enabled: true,
        rateLimitResetTimes: {},
        consecutiveFailures: 0,
        lastFailureTime: null,
      })),
    };
    mockLoadAccounts.mockResolvedValue(fullStorage);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");

    try {
      const code = await cmdLogin();
      expect(code).toBe(1);
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining("maximum of 10 accounts reached"));
      expect(saveAccounts).not.toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });

  it("cmdLogout removes one account and revokes token", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());

    const code = await cmdLogout("2", { force: true });
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalledWith("refresh-bob");
    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts).toHaveLength(2);
    expect(saved.accounts.find((a) => a.refreshToken === "refresh-bob")).toBeUndefined();
  });

  it("cmdLogout --all revokes all accounts and writes explicit empty storage", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());

    const code = await cmdLogout(undefined, { all: true, force: true });
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalledTimes(3);
    expect(saveAccounts).toHaveBeenCalledWith({
      version: 1,
      accounts: [],
      activeIndex: 0,
    });
  });

  it("cmdReauth refreshes credentials and resets account failure state", async () => {
    const storage = makeStorage();
    storage.accounts[0].enabled = false;
    storage.accounts[0].consecutiveFailures = 5;
    storage.accounts[0].lastFailureTime = Date.now();
    storage.accounts[0].rateLimitResetTimes = {
      anthropic: Date.now() + 60_000,
    };
    mockLoadAccounts.mockResolvedValue(storage);
    mockExchange.mockResolvedValueOnce({
      type: "success",
      refresh: "refresh-reauth",
      access: "access-reauth",
      expires: Date.now() + 7200_000,
      email: "alice+reauth@example.com",
    });

    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("reauth-code#state");

    try {
      const code = await cmdReauth("1");
      expect(code).toBe(0);
      const saved = mockSaveAccounts.mock.calls[0][0];
      expect(saved.accounts[0]).toEqual(
        expect.objectContaining({
          refreshToken: "refresh-reauth",
          access: "access-reauth",
          email: "alice+reauth@example.com",
          enabled: true,
          consecutiveFailures: 0,
          lastFailureTime: null,
          rateLimitResetTimes: {},
        }),
      );
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("re-enabled"));
    } finally {
      restoreTTY();
    }
  });

  it("cmdRefresh updates tokens and re-enables account", async () => {
    const storage = makeStorage();
    storage.accounts[2].enabled = false;
    storage.accounts[2].consecutiveFailures = 4;
    storage.accounts[2].lastFailureTime = Date.now();
    storage.accounts[2].rateLimitResetTimes = {
      anthropic: Date.now() + 30_000,
    };
    mockLoadAccounts.mockResolvedValue(storage);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }),
    });

    const code = await cmdRefresh("3");
    expect(code).toBe(0);
    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts[2]).toEqual(
      expect.objectContaining({
        access: "fresh-access",
        refreshToken: "fresh-refresh",
        enabled: true,
        consecutiveFailures: 0,
        lastFailureTime: null,
        rateLimitResetTimes: {},
      }),
    );
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Token refreshed"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("re-enabled"));
  });

  it("cmdRefresh suggests reauth when refresh fails", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const code = await cmdRefresh("1");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Try: opencode-anthropic-auth reauth 1"));
    expect(saveAccounts).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cmdRemove
// ---------------------------------------------------------------------------

describe("cmdRemove", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  it("removes account with --force (no confirmation)", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdRemove("2", { force: true });
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Removed"));
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Account 2"));

    expect(saveAccounts).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.arrayContaining([
          expect.objectContaining({ email: "alice@example.com" }),
          expect.objectContaining({ email: "charlie@example.com" }),
        ]),
      }),
    );
    // Should have 2 accounts remaining (alice + charlie)
    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts).toHaveLength(2);
  });

  it("adjusts activeIndex when removing account before active", async () => {
    const storage = makeStorage({ activeIndex: 2 }); // charlie is active
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdRemove("1", { force: true }); // remove alice (before active)
    expect(code).toBe(0);

    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.activeIndex).toBe(1); // shifted down by 1
  });

  it("resets activeIndex when removing last account", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.activeIndex = 0;
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdRemove("1", { force: true });
    expect(code).toBe(0);

    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts).toHaveLength(0);
    expect(saved.activeIndex).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("No accounts remaining"));
  });

  it("rejects invalid account number", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdRemove("99", { force: true });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });

  it("prompts for confirmation with confirm() when not forced", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const restoreTTY = setStdinTTY(true);
    mockConfirmAnswer(true);
    try {
      const code = await cmdRemove("2");
      expect(code).toBe(0);
      expect(confirm).toHaveBeenCalled();
      expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Removed"));
    } finally {
      restoreTTY();
    }
  });

  it("cancels removal when user declines confirm", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const restoreTTY = setStdinTTY(true);
    mockConfirmAnswer(false);
    try {
      const code = await cmdRemove("2");
      expect(code).toBe(0);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Cancelled"));
      expect(saveAccounts).not.toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });
});

// ---------------------------------------------------------------------------
// cmdReset
// ---------------------------------------------------------------------------

describe("cmdReset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  it("resets tracking for a single account", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 5;
    storage.accounts[0].lastFailureTime = Date.now();
    storage.accounts[0].rateLimitResetTimes = {
      anthropic: Date.now() + 60_000,
    };
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("1");
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Reset tracking"));
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("alice@example.com"));

    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].consecutiveFailures).toBe(0);
    expect(saved.accounts[0].lastFailureTime).toBeNull();
    expect(saved.accounts[0].rateLimitResetTimes).toEqual({});
  });

  it("resets tracking for all accounts", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 3;
    storage.accounts[1].consecutiveFailures = 7;
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("all");
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("all 3 account(s)"));

    const saved = mockSaveAccounts.mock.calls[0][0];
    for (const acc of saved.accounts) {
      expect(acc.consecutiveFailures).toBe(0);
      expect(acc.lastFailureTime).toBeNull();
      expect(acc.rateLimitResetTimes).toEqual({});
    }
  });

  it("rejects missing argument", async () => {
    const code = await cmdReset(undefined);
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("provide an account number"));
  });

  it("rejects invalid account number", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdReset("99");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });
});

// ---------------------------------------------------------------------------
// cmdConfig
// ---------------------------------------------------------------------------

describe("cmdConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("displays configuration values", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdConfig();
    expect(code).toBe(0);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Anthropic Auth Configuration"));
    expect(note).toHaveBeenCalledWith(expect.stringContaining("sticky"), "General");
    expect(note).toHaveBeenCalledWith(expect.stringContaining("3600s"), "General");
    expect(note).toHaveBeenCalledWith(expect.stringContaining("off"), "General");
  });

  it("shows health score config", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);

    expect(note).toHaveBeenCalledWith(expect.stringContaining("70"), "Health Score");
    expect(note).toHaveBeenCalledWith(expect.stringContaining("+1"), "Health Score");
    expect(note).toHaveBeenCalledWith(expect.stringContaining("-10"), "Health Score");
  });

  it("shows token bucket config", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);

    expect(note).toHaveBeenCalledWith(expect.stringContaining("50"), "Token Bucket");
  });

  it("shows file paths", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);

    expect(note).toHaveBeenCalledWith(expect.stringContaining("anthropic-auth.json"), "Files");
    expect(note).toHaveBeenCalledWith(expect.stringContaining("anthropic-accounts.json"), "Files");
  });

  it("shows account count when accounts exist", async () => {
    mockLoadAccounts.mockResolvedValue(makeStorage());
    const code = await cmdConfig();
    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(expect.stringContaining("3 (2 enabled)"), "Files");
  });

  it("shows 'none' when no accounts exist", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdConfig();
    expect(code).toBe(0);
    expect(note).toHaveBeenCalledWith(expect.stringContaining("none"), "Files");
  });
});

// ---------------------------------------------------------------------------
// cmdStrategy
// ---------------------------------------------------------------------------

describe("cmdStrategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows current strategy when called without args", async () => {
    const code = await cmdStrategy();
    expect(code).toBe(0);

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Account Selection Strategy"));
    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("sticky"));
    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("round-robin"));
    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("hybrid"));
  });

  it("changes strategy when given valid arg", async () => {
    const code = await cmdStrategy("round-robin");
    expect(code).toBe(0);

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("round-robin"));
  });

  it("rejects invalid strategy name", async () => {
    const code = await cmdStrategy("invalid-strategy");
    expect(code).toBe(1);

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Invalid strategy"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("invalid-strategy"));
  });

  it("detects when strategy is already set", async () => {
    const code = await cmdStrategy("sticky");
    expect(code).toBe(0);

    expect(log.message).toHaveBeenCalledWith(expect.stringContaining("already"));
  });

  it("normalizes strategy input to lowercase", async () => {
    const code = await cmdStrategy("ROUND-ROBIN");
    expect(code).toBe(0);

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("round-robin"));
  });
});

// ---------------------------------------------------------------------------
// cmdHelp
// ---------------------------------------------------------------------------

describe("cmdHelp", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it("shows all commands", () => {
    cmdHelp();
    const text = output.text();
    expect(text).toContain("login");
    expect(text).toContain("logout");
    expect(text).toContain("reauth");
    expect(text).toContain("refresh");
    expect(text).toContain("list");
    expect(text).toContain("status");
    expect(text).toContain("switch");
    expect(text).toContain("enable");
    expect(text).toContain("disable");
    expect(text).toContain("remove");
    expect(text).toContain("reset");
    expect(text).toContain("config");
    expect(text).toContain("manage");
    expect(text).toContain("help");
  });

  it("shows examples", () => {
    cmdHelp();
    const text = output.text();
    expect(text).toContain("logout --all");
    expect(text).toContain("reauth <N>");
    expect(text).toContain("switch <N>");
    expect(text).toContain("disable <N>");
    expect(text).toContain("reset <N|all>");
    // New grouped format examples
    expect(text).toContain("auth login");
    expect(text).toContain("account list");
    expect(text).toContain("usage stats");
  });
});

// ---------------------------------------------------------------------------
// main() routing
// ---------------------------------------------------------------------------

describe("main routing", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
    mockSpinner.mockReturnValue({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    });
    mockLoadAccounts.mockResolvedValue(makeStorage());
    mockSaveAccounts.mockResolvedValue(undefined);
    mockAuthorize.mockResolvedValue({
      url: "https://auth.example/authorize",
      verifier: "pkce-verifier",
    });
    mockExchange.mockResolvedValue({
      type: "success",
      refresh: "refresh-new",
      access: "access-new",
      expires: Date.now() + 3600_000,
      email: "new@example.com",
    });
    mockRevoke.mockResolvedValue(true);
  });

  afterEach(() => {
    output.restore();
  });

  it("defaults to list when no command given", async () => {
    const code = await main([]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Status");
  });

  it("routes 'ls' alias to list", async () => {
    const code = await main(["ls"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Status");
  });

  it("routes 'st' alias to status", async () => {
    const code = await main(["st"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("anthropic:");
  });

  it("routes 'sw' alias to switch", async () => {
    const code = await main(["sw", "2"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Switched");
  });

  it("routes 'en' alias to enable", async () => {
    const code = await main(["en", "3"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Enabled");
  });

  it("routes 'rm' alias to remove with --force", async () => {
    const code = await main(["rm", "2", "--force"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Removed");
  });

  it("routes 'cfg' alias to config", async () => {
    const code = await main(["cfg"]);
    expect(code).toBe(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Anthropic Auth Configuration"));
  });

  it("returns error for unknown command", async () => {
    const code = await main(["foobar"]);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("Unknown command");
  });

  it("routes -h to help", async () => {
    const code = await main(["-h"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Auth CLI");
  });

  it("routes --help to help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Anthropic Multi-Account Auth CLI");
  });

  it("strips --flags from args before routing", async () => {
    const code = await main(["switch", "1", "--force", "--no-color"]);
    expect(code).toBe(0);
    // Should have routed to switch with arg "1", not "--force"
    expect(output.text()).toContain("Switched");
  });

  it("routes 'dis' alias to disable", async () => {
    const code = await main(["dis", "2"]);
    expect(code).toBe(0);
    expect(output.text()).toContain("Disabled");
  });

  it("routes 'ln' alias to login", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("auth-code#state");
    try {
      const code = await main(["ln"]);
      expect(code).toBe(0);
      expect(authorize).toHaveBeenCalledWith("max");
      expect(exchange).toHaveBeenCalled();
    } finally {
      restoreTTY();
    }
  });

  it("routes 'lo --all --force' alias to logout all", async () => {
    const code = await main(["lo", "--all", "--force"]);
    expect(code).toBe(0);
    expect(revoke).toHaveBeenCalled();
    expect(saveAccounts).toHaveBeenCalledWith({
      version: 1,
      accounts: [],
      activeIndex: 0,
    });
  });

  it("routes 'ra' alias to reauth", async () => {
    const restoreTTY = setStdinTTY(true);
    mockReadlineAnswer("reauth-code#state");
    try {
      const code = await main(["ra", "1"]);
      expect(code).toBe(0);
      expect(exchange).toHaveBeenCalled();
      expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Re-authenticated"));
    } finally {
      restoreTTY();
    }
  });

  it("routes 'rf' alias to refresh", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 3600,
      }),
    });
    const code = await main(["rf", "1"]);
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining("Token refreshed"));
  });

  it("supports integration io capture option", async () => {
    // This test validates IO redirection itself, so disable outer capture hook.
    output.restore();

    const logs: string[] = [];
    const errors: string[] = [];
    const code = await main(["status"], {
      io: {
        log: (...args) => logs.push(args.join(" ")),
        error: (...args) => errors.push(args.join(" ")),
      },
    });

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(logs.join("\n")).toContain("anthropic:");
  });
});

// ---------------------------------------------------------------------------
// Edge cases: missing arguments
// ---------------------------------------------------------------------------

describe("missing argument handling", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
    mockLoadAccounts.mockResolvedValue(makeStorage());
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("cmdSwitch rejects undefined arg", async () => {
    const code = await cmdSwitch(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("cmdEnable rejects undefined arg", async () => {
    const code = await cmdEnable(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("cmdDisable rejects undefined arg", async () => {
    const code = await cmdDisable(undefined);
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });

  it("cmdRemove rejects undefined arg", async () => {
    const code = await cmdRemove(undefined, { force: true });
    expect(code).toBe(1);
    expect(output.errorText()).toContain("valid account number");
  });
});

// ---------------------------------------------------------------------------
// Case insensitivity
// ---------------------------------------------------------------------------

describe("case insensitivity", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    output.restore();
  });

  it("cmdReset accepts 'ALL' (uppercase)", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 3;
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("ALL");
    expect(code).toBe(0);
    expect(output.text()).toContain("all 3 account(s)");
  });

  it("cmdReset accepts 'All' (mixed case)", async () => {
    const storage = makeStorage();
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdReset("All");
    expect(code).toBe(0);
    expect(output.text()).toContain("all 3 account(s)");
  });
});

// ---------------------------------------------------------------------------
// cmdRemove: active account removal
// ---------------------------------------------------------------------------

describe("cmdRemove active account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  it("adjusts activeIndex when removing the active account", async () => {
    const storage = makeStorage({ activeIndex: 1 }); // bob is active
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdRemove("2", { force: true }); // remove bob
    expect(code).toBe(0);

    const saved = mockSaveAccounts.mock.calls[0][0];
    // activeIndex was 1, we removed index 1, so it should clamp to length-1 = 1
    // (now pointing to charlie, the new index 1)
    expect(saved.activeIndex).toBe(1);
    expect(saved.accounts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// cmdStats
// ---------------------------------------------------------------------------

describe("cmdStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function statsMessages() {
    return (log.message as Mock).mock.calls
      .map((call) => String(call[0]))
      .join("\n")
      .replace(ANSI_REGEX, "");
  }

  function makeStatsStorage() {
    const storage = makeStorage();
    storage.accounts[0].stats = {
      requests: 142,
      inputTokens: 1_200_000,
      outputTokens: 380_000,
      cacheReadTokens: 890_000,
      cacheWriteTokens: 45_000,
      lastReset: Date.now() - 86400_000,
    };
    storage.accounts[1].email = "bob@example.com";
    storage.accounts[1].stats = {
      requests: 87,
      inputTokens: 720_000,
      outputTokens: 210_000,
      cacheReadTokens: 540_000,
      cacheWriteTokens: 32_000,
      lastReset: Date.now() - 86400_000,
    };
    return storage;
  }

  it("displays per-account usage statistics", async () => {
    mockLoadAccounts.mockResolvedValue(makeStatsStorage());
    const code = await cmdStats();
    expect(code).toBe(0);
    const text = statsMessages();
    expect(text).toContain("alice@example.com");
    expect(text).toContain("bob@example.com");
    expect(text).toContain("142");
    expect(text).toContain("87");
    expect(text).toContain("1.2M");
    expect(text).toContain("Total");
  });

  it("returns 1 when no accounts configured", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdStats();
    expect(code).toBe(1);
    expect(log.warn).toHaveBeenCalledWith("No accounts configured.");
  });

  it("handles accounts with no stats (defaults)", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]]; // single account, no stats field
    mockLoadAccounts.mockResolvedValue(storage);
    const code = await cmdStats();
    expect(code).toBe(0);
    const text = statsMessages();
    expect(text).toContain("alice@example.com");
    expect(text).toContain("0");
  });
});

// ---------------------------------------------------------------------------
// cmdResetStats
// ---------------------------------------------------------------------------

describe("cmdResetStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveAccounts.mockResolvedValue(undefined);
  });

  it("resets stats for all accounts", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.accounts[0].stats = {
      requests: 100,
      inputTokens: 50000,
      outputTokens: 20000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    };
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("all");
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith("Reset usage statistics for all accounts.");

    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].stats.requests).toBe(0);
    expect(saved.accounts[0].stats.inputTokens).toBe(0);
  });

  it("resets stats for a single account", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.accounts[0].stats = {
      requests: 100,
      inputTokens: 50000,
      outputTokens: 20000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    };
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("1");
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith("Reset usage statistics for alice@example.com.");
  });

  it("returns 1 for invalid account number", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats("99");
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith("Invalid account number. Use 1-1 or 'all'.");
  });

  it("resets all accounts when no argument given", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]];
    storage.accounts[0].stats = {
      requests: 50,
      inputTokens: 10000,
      outputTokens: 5000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    };
    mockLoadAccounts.mockResolvedValue(storage);

    const code = await cmdResetStats();
    expect(code).toBe(0);
    expect(log.success).toHaveBeenCalledWith("Reset usage statistics for all accounts.");

    const saved = mockSaveAccounts.mock.calls[0][0];
    expect(saved.accounts[0].stats.requests).toBe(0);
  });

  it("returns 1 when no accounts configured", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdResetStats("all");
    expect(code).toBe(1);
    expect(log.warn).toHaveBeenCalledWith("No accounts configured.");
  });
});

// ---------------------------------------------------------------------------
// cmdManage
// ---------------------------------------------------------------------------

describe("cmdManage", () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    vi.clearAllMocks();
    output = captureOutput();
    mockSaveAccounts.mockResolvedValue(undefined);
    mockLoadAccounts.mockResolvedValue(makeStorage());
    mockSelect.mockResolvedValue("quit");
  });

  afterEach(() => {
    output.restore();
  });

  it("returns 1 when no accounts configured", async () => {
    mockLoadAccounts.mockResolvedValue(null);
    const code = await cmdManage();
    expect(code).toBe(1);
    expect(output.text()).toContain("No accounts configured");
  });

  it("returns 1 when accounts array is empty", async () => {
    mockLoadAccounts.mockResolvedValue({ version: 1, accounts: [], activeIndex: 0 });
    const code = await cmdManage();
    expect(code).toBe(1);
    expect(output.text()).toContain("No accounts configured");
  });

  it("rejects non-interactive terminals", async () => {
    const restoreTTY = setStdinTTY(false);
    try {
      const code = await cmdManage();
      expect(code).toBe(1);
      expect(output.errorText()).toContain("requires an interactive terminal");
    } finally {
      restoreTTY();
    }
  });

  it("displays account list with active/disabled status", async () => {
    const restoreTTY = setStdinTTY(true);
    mockSelect.mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      expect(output.text()).toContain("alice@example.com");
      expect(output.text()).toContain("charlie@example.com");
    } finally {
      restoreTTY();
    }
  });

  it("switches active account via manage menu", async () => {
    const restoreTTY = setStdinTTY(true);
    mockSelect
      .mockResolvedValueOnce("switch")
      .mockResolvedValueOnce("1") // select account index 1 (bob)
      .mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      expect(saveAccounts).toHaveBeenCalledWith(expect.objectContaining({ activeIndex: 1 }));
    } finally {
      restoreTTY();
    }
  });

  it("enables disabled account via manage menu", async () => {
    const restoreTTY = setStdinTTY(true);
    mockSelect
      .mockResolvedValueOnce("enable")
      .mockResolvedValueOnce("2") // select account index 2 (charlie, disabled)
      .mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      const saved = mockSaveAccounts.mock.calls[0][0];
      expect(saved.accounts[2].enabled).toBe(true);
    } finally {
      restoreTTY();
    }
  });

  it("disables enabled account via manage menu", async () => {
    const restoreTTY = setStdinTTY(true);
    mockSelect
      .mockResolvedValueOnce("disable")
      .mockResolvedValueOnce("1") // select account index 1 (bob, enabled)
      .mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      const saved = mockSaveAccounts.mock.calls[0][0];
      expect(saved.accounts[1].enabled).toBe(false);
    } finally {
      restoreTTY();
    }
  });

  it("prevents disabling last enabled account", async () => {
    const storage = makeStorage();
    storage.accounts = [storage.accounts[0]]; // only one account
    mockLoadAccounts.mockResolvedValue(storage);
    const restoreTTY = setStdinTTY(true);
    mockSelect.mockResolvedValueOnce("disable").mockResolvedValueOnce("0").mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      // Should not save since we can't disable the last enabled account
      expect(saveAccounts).not.toHaveBeenCalled();
      expect(output.text()).toContain("Cannot disable the last enabled account");
    } finally {
      restoreTTY();
    }
  });

  it("removes account with confirmation via manage menu", async () => {
    const restoreTTY = setStdinTTY(true);
    mockConfirm.mockResolvedValueOnce(true);
    mockSelect
      .mockResolvedValueOnce("remove")
      .mockResolvedValueOnce("1") // select account index 1 (bob)
      .mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      const saved = mockSaveAccounts.mock.calls[0][0];
      expect(saved.accounts).toHaveLength(2);
      expect(saved.accounts.find((a) => a.refreshToken === "refresh-bob")).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("resets account tracking via manage menu", async () => {
    const storage = makeStorage();
    storage.accounts[0].consecutiveFailures = 5;
    storage.accounts[0].lastFailureTime = Date.now();
    storage.accounts[0].rateLimitResetTimes = { anthropic: Date.now() + 60_000 };
    mockLoadAccounts.mockResolvedValue(storage);
    const restoreTTY = setStdinTTY(true);
    mockSelect
      .mockResolvedValueOnce("reset")
      .mockResolvedValueOnce("0") // select account index 0 (alice)
      .mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      const saved = mockSaveAccounts.mock.calls[0][0];
      expect(saved.accounts[0].consecutiveFailures).toBe(0);
      expect(saved.accounts[0].lastFailureTime).toBeNull();
      expect(saved.accounts[0].rateLimitResetTimes).toEqual({});
    } finally {
      restoreTTY();
    }
  });

  it("changes strategy via manage menu", async () => {
    const restoreTTY = setStdinTTY(true);
    mockSelect.mockResolvedValueOnce("strategy").mockResolvedValueOnce("round-robin").mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
      expect(output.text()).toContain("Strategy changed to 'round-robin'");
    } finally {
      restoreTTY();
    }
  });

  it("exits when user selects quit", async () => {
    const restoreTTY = setStdinTTY(true);
    mockSelect.mockResolvedValueOnce("quit");
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
    } finally {
      restoreTTY();
    }
  });

  it("exits when user cancels action selection", async () => {
    const restoreTTY = setStdinTTY(true);
    mockIsCancel.mockReturnValueOnce(true);
    mockSelect.mockResolvedValueOnce(undefined);
    try {
      const code = await cmdManage();
      expect(code).toBe(0);
    } finally {
      restoreTTY();
    }
  });
});
