import { appendFileSync, existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  clearAccounts,
  createDefaultStats,
  deduplicateByRefreshToken,
  ensureGitignore,
  getStoragePath,
  loadAccounts,
  saveAccounts,
} from "./storage.js";
import type { AccountMetadata, AccountStorage } from "./storage.js";

// Mock fs modules
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({
    toString: () => "abcdef123456",
  })),
}));

const mockExistsSync = existsSync as Mock;
const mockReadFileSync = readFileSync as Mock;
const mockFsReadFile = fs.readFile as Mock;
const mockFsWriteFile = fs.writeFile as Mock;
const mockFsRename = fs.rename as Mock;
const mockFsMkdir = fs.mkdir as Mock;
const mockFsChmod = fs.chmod as Mock;
const mockFsUnlink = fs.unlink as Mock;

function makeAccount(overrides: Partial<AccountMetadata> & Pick<AccountMetadata, "refreshToken">): AccountMetadata {
  const addedAt = overrides.addedAt ?? 1000;

  return {
    id: overrides.id ?? `${addedAt}:${overrides.refreshToken.slice(0, 12)}`,
    refreshToken: overrides.refreshToken,
    token_updated_at: overrides.token_updated_at ?? addedAt,
    addedAt,
    lastUsed: overrides.lastUsed ?? 0,
    enabled: overrides.enabled ?? true,
    rateLimitResetTimes: overrides.rateLimitResetTimes ?? {},
    consecutiveFailures: overrides.consecutiveFailures ?? 0,
    lastFailureTime: overrides.lastFailureTime ?? null,
    stats: overrides.stats ?? createDefaultStats(addedAt),
    email: overrides.email,
    identity: overrides.identity,
    label: overrides.label,
    access: overrides.access,
    expires: overrides.expires,
    lastSwitchReason: overrides.lastSwitchReason,
    source: overrides.source,
  };
}

function expectLoaded(result: AccountStorage | null): AccountStorage {
  expect(result).not.toBeNull();
  return result as AccountStorage;
}

// ---------------------------------------------------------------------------
// deduplicateByRefreshToken
// ---------------------------------------------------------------------------

describe("deduplicateByRefreshToken", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateByRefreshToken([])).toEqual([]);
  });

  it("returns single account unchanged", () => {
    const accounts = [makeAccount({ refreshToken: "token1", addedAt: 1000, lastUsed: 2000 })];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(1);
    expect(result[0].refreshToken).toBe("token1");
  });

  it("keeps most recently used when duplicates exist", () => {
    const accounts = [
      makeAccount({ refreshToken: "token1", addedAt: 1000, lastUsed: 1000 }),
      makeAccount({ refreshToken: "token1", addedAt: 2000, lastUsed: 5000 }),
    ];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(1);
    expect(result[0].lastUsed).toBe(5000);
  });

  it("keeps different tokens as separate accounts", () => {
    const accounts = [
      makeAccount({ refreshToken: "token1", addedAt: 1000, lastUsed: 1000 }),
      makeAccount({ refreshToken: "token2", addedAt: 2000, lastUsed: 2000 }),
    ];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(2);
  });

  it("skips accounts without refreshToken", () => {
    const accounts = [makeAccount({ refreshToken: "", addedAt: 1000, lastUsed: 1000 })];
    const result = deduplicateByRefreshToken(accounts);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ensureGitignore
// ---------------------------------------------------------------------------

describe("ensureGitignore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates new .gitignore when none exists", () => {
    mockExistsSync.mockReturnValue(false);
    ensureGitignore("/config/dir");
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]config[\\/]dir[\\/]\.gitignore$/),
      expect.stringContaining("anthropic-accounts.json"),
      "utf-8",
    );
  });

  it("appends missing entries to existing .gitignore", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("some-other-file\n");
    ensureGitignore("/config/dir");
    expect(appendFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]config[\\/]dir[\\/]\.gitignore$/),
      expect.stringContaining("anthropic-accounts.json"),
      "utf-8",
    );
  });

  it("does nothing when all entries already present", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(".gitignore\nanthropic-accounts.json\nanthropic-accounts.json.*.tmp\n");
    ensureGitignore("/config/dir");
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("handles errors gracefully", () => {
    mockExistsSync.mockImplementation(() => {
      throw new Error("permission denied");
    });
    // Should not throw
    expect(() => ensureGitignore("/config/dir")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getStoragePath
// ---------------------------------------------------------------------------

describe("getStoragePath", () => {
  it("returns path ending with anthropic-accounts.json", () => {
    const path = getStoragePath();
    expect(path.endsWith("anthropic-accounts.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAccounts
// ---------------------------------------------------------------------------

describe("loadAccounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when file does not exist", async () => {
    mockFsReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    mockFsReadFile.mockResolvedValue("not json");
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("warns and returns best-effort data for unknown version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 99,
        accounts: [{ refreshToken: "token1", enabled: false }],
        activeIndex: 0,
      }),
    );

    const result = await loadAccounts();

    expect(warn).toHaveBeenCalledWith("Storage version mismatch: 99 vs 1. Attempting best-effort migration.");
    expect(result).not.toBeNull();
    expect(result?.version).toBe(1);
    expect(result?.accounts).toHaveLength(1);
    expect(result?.accounts[0]?.refreshToken).toBe("token1");
    expect(result?.accounts[0]?.enabled).toBe(false);

    warn.mockRestore();
  });

  it("returns null when accounts is not an array", async () => {
    mockFsReadFile.mockResolvedValue(JSON.stringify({ version: 1, accounts: "not-array" }));
    const result = await loadAccounts();
    expect(result).toBeNull();
  });

  it("loads valid accounts", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            refreshToken: "token1",
            access: "access1",
            expires: 9999999999,
            addedAt: 1000,
            lastUsed: 2000,
            enabled: true,
            rateLimitResetTimes: {},
            consecutiveFailures: 0,
            lastFailureTime: null,
          },
        ],
        activeIndex: 0,
      }),
    );
    const result = expectLoaded(await loadAccounts());
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].refreshToken).toBe("token1");
    expect(result.accounts[0].access).toBe("access1");
    expect(result.accounts[0].expires).toBe(9999999999);
    expect(result.activeIndex).toBe(0);
  });

  it("preserves stored source values and leaves missing source undefined", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            refreshToken: "token1",
            source: "cc-file",
            label: "Imported Claude Code",
          },
          {
            refreshToken: "token2",
          },
        ],
        activeIndex: 0,
      }),
    );

    const result = expectLoaded(await loadAccounts());

    expect(result.accounts[0]?.source).toBe("cc-file");
    expect(result.accounts[0]?.label).toBe("Imported Claude Code");
    expect(result.accounts[1]?.source).toBeUndefined();
  });

  it("filters out invalid accounts (missing refreshToken)", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [{ refreshToken: "valid", addedAt: 1000 }, { email: "no-token" }, null],
        activeIndex: 0,
      }),
    );
    const result = expectLoaded(await loadAccounts());
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].refreshToken).toBe("valid");
  });

  it("clamps activeIndex to valid range", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [{ refreshToken: "token1" }],
        activeIndex: 99,
      }),
    );
    const result = expectLoaded(await loadAccounts());
    expect(result.activeIndex).toBe(0);
  });

  it("deduplicates accounts by refresh token", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          { refreshToken: "token1", lastUsed: 1000 },
          { refreshToken: "token1", lastUsed: 5000 },
        ],
        activeIndex: 0,
      }),
    );
    const result = expectLoaded(await loadAccounts());
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].lastUsed).toBe(5000);
  });

  it("applies defaults for missing fields", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [{ refreshToken: "token1" }],
        activeIndex: 0,
      }),
    );
    const result = expectLoaded(await loadAccounts());
    const acc = result.accounts[0]!;
    expect(acc.enabled).toBe(true);
    expect(acc.consecutiveFailures).toBe(0);
    expect(acc.lastFailureTime).toBeNull();
    expect(acc.rateLimitResetTimes).toEqual({});
    expect(acc.lastUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// saveAccounts
// ---------------------------------------------------------------------------

describe("saveAccounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(".gitignore\nanthropic-accounts.json\nanthropic-accounts.json.*.tmp\n");
    mockFsMkdir.mockResolvedValue(undefined);
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsRename.mockResolvedValue(undefined);
    mockFsChmod.mockResolvedValue(undefined);
  });

  it("writes atomically via temp file + rename", async () => {
    const storage = {
      version: 1,
      accounts: [makeAccount({ refreshToken: "token1" })],
      activeIndex: 0,
    };
    await saveAccounts(storage);

    expect(mockFsWriteFile).toHaveBeenCalledWith(expect.stringContaining(".tmp"), expect.any(String), {
      encoding: "utf-8",
      mode: 0o600,
    });
    expect(mockFsRename).toHaveBeenCalled();
  });

  it("creates config directory if needed", async () => {
    const storage = { version: 1, accounts: [], activeIndex: 0 };
    await saveAccounts(storage);
    expect(mockFsMkdir).toHaveBeenCalledWith(expect.any(String), {
      recursive: true,
    });
  });

  it("cleans up temp file on write error", async () => {
    mockFsWriteFile.mockRejectedValue(new Error("disk full"));
    mockFsUnlink.mockResolvedValue(undefined);

    const storage = { version: 1, accounts: [], activeIndex: 0 };
    await expect(saveAccounts(storage)).rejects.toThrow("disk full");
    expect(mockFsUnlink).toHaveBeenCalledWith(expect.stringContaining(".tmp"));
  });

  it("merges auth fields from fresher disk state", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "a1",
            refreshToken: "disk-refresh",
            access: "disk-access",
            expires: 999999,
            token_updated_at: 2000,
            addedAt: 1000,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
            consecutiveFailures: 0,
            lastFailureTime: null,
            stats: createDefaultStats(1000),
          },
        ],
        activeIndex: 0,
      }),
    );

    const storage = {
      version: 1,
      accounts: [
        {
          id: "a1",
          refreshToken: "mem-refresh",
          access: "mem-access",
          expires: 123,
          token_updated_at: 1000,
          addedAt: 1000,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          stats: createDefaultStats(1000),
        },
      ],
      activeIndex: 0,
    };

    await saveAccounts(storage);

    const written = JSON.parse(mockFsWriteFile.mock.calls[0][1]);
    expect(written.accounts[0].refreshToken).toBe("disk-refresh");
    expect(written.accounts[0].access).toBe("disk-access");
    expect(written.accounts[0].expires).toBe(999999);
    expect(written.accounts[0].token_updated_at).toBe(2000);
  });

  it("matches id-less disk accounts by addedAt during freshness merge", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            refreshToken: "disk-refresh-rotated",
            access: "disk-access",
            expires: 888888,
            token_updated_at: 3000,
            addedAt: 1111,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
            consecutiveFailures: 0,
            lastFailureTime: null,
            stats: createDefaultStats(1111),
          },
        ],
        activeIndex: 0,
      }),
    );

    const storage = {
      version: 1,
      accounts: [
        {
          id: "legacy-a1",
          refreshToken: "old-refresh",
          access: "old-access",
          expires: 111,
          token_updated_at: 1000,
          addedAt: 1111,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          stats: createDefaultStats(1111),
        },
      ],
      activeIndex: 0,
    };

    await saveAccounts(storage);

    const written = JSON.parse(mockFsWriteFile.mock.calls[0][1]);
    expect(written.accounts[0].refreshToken).toBe("disk-refresh-rotated");
    expect(written.accounts[0].token_updated_at).toBe(3000);
  });

  it("does not resurrect accounts removed by caller", async () => {
    mockFsReadFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "a1",
            refreshToken: "disk-refresh",
            token_updated_at: 2000,
            addedAt: 1000,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
            consecutiveFailures: 0,
            lastFailureTime: null,
            stats: createDefaultStats(1000),
          },
        ],
        activeIndex: 0,
      }),
    );

    await saveAccounts({ version: 1, accounts: [], activeIndex: 0 });

    const written = JSON.parse(mockFsWriteFile.mock.calls[0][1]);
    expect(written.accounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// clearAccounts
// ---------------------------------------------------------------------------

describe("clearAccounts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("deletes the storage file", async () => {
    mockFsUnlink.mockResolvedValue(undefined);
    await clearAccounts();
    expect(mockFsUnlink).toHaveBeenCalledWith(expect.stringContaining("anthropic-accounts.json"));
  });

  it("ignores ENOENT errors", async () => {
    mockFsUnlink.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(clearAccounts()).resolves.toBeUndefined();
  });

  it("rethrows non-ENOENT errors", async () => {
    mockFsUnlink.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(clearAccounts()).rejects.toThrow("permission denied");
  });
});

// ---------------------------------------------------------------------------
// Stats validation
// ---------------------------------------------------------------------------

describe("createDefaultStats", () => {
  it("creates zeroed stats with given timestamp", () => {
    const stats = createDefaultStats(1000);
    expect(stats).toEqual({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      lastReset: 1000,
    });
  });

  it("uses Date.now() when no timestamp given", () => {
    const before = Date.now();
    const stats = createDefaultStats();
    expect(stats.lastReset).toBeGreaterThanOrEqual(before);
    expect(stats.lastReset).toBeLessThanOrEqual(Date.now());
  });
});

describe("loadAccounts with stats", () => {
  it("loads accounts with stats fields preserved", async () => {
    const stored = {
      version: 1,
      accounts: [
        {
          refreshToken: "tok1",
          stats: {
            requests: 42,
            inputTokens: 10000,
            outputTokens: 5000,
            cacheReadTokens: 2000,
            cacheWriteTokens: 100,
            lastReset: 1700000000000,
          },
        },
      ],
      activeIndex: 0,
    };
    mockFsReadFile.mockResolvedValue(JSON.stringify(stored));

    const result = expectLoaded(await loadAccounts());
    expect(result.accounts[0].stats.requests).toBe(42);
    expect(result.accounts[0].stats.inputTokens).toBe(10000);
    expect(result.accounts[0].stats.outputTokens).toBe(5000);
    expect(result.accounts[0].stats.cacheReadTokens).toBe(2000);
    expect(result.accounts[0].stats.cacheWriteTokens).toBe(100);
    expect(result.accounts[0].stats.lastReset).toBe(1700000000000);
  });

  it("provides default stats when missing from stored data", async () => {
    const stored = {
      version: 1,
      accounts: [{ refreshToken: "tok1" }],
      activeIndex: 0,
    };
    mockFsReadFile.mockResolvedValue(JSON.stringify(stored));

    const result = expectLoaded(await loadAccounts());
    expect(result.accounts[0].stats.requests).toBe(0);
    expect(result.accounts[0].stats.inputTokens).toBe(0);
    expect(result.accounts[0].stats.outputTokens).toBe(0);
  });

  it("clamps negative stats values to 0", async () => {
    const stored = {
      version: 1,
      accounts: [
        {
          refreshToken: "tok1",
          stats: { requests: -5, inputTokens: -100, outputTokens: NaN },
        },
      ],
      activeIndex: 0,
    };
    mockFsReadFile.mockResolvedValue(JSON.stringify(stored));

    const result = expectLoaded(await loadAccounts());
    expect(result.accounts[0].stats.requests).toBe(0);
    expect(result.accounts[0].stats.inputTokens).toBe(0);
    expect(result.accounts[0].stats.outputTokens).toBe(0);
  });
});
