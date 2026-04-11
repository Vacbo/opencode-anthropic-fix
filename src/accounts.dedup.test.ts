import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_CONFIG } from "./config.js";
import type { AccountStorage } from "./storage.js";
import { createInMemoryStorage, makeAccountsData, makeStoredAccount } from "./__tests__/helpers/in-memory-storage.js";
import type * as StorageModule from "./storage.js";
import type * as ConfigModule from "./config.js";

type CCCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  source: "cc-keychain" | "cc-file";
  label: string;
  subscriptionType?: string;
};

type LoadManagerOptions = {
  authFallback?: {
    refresh: string;
    access?: string;
    expires?: number;
  } | null;
  ccCredentials?: CCCredential[];
  config?: typeof DEFAULT_CONFIG;
  initialStorage?: AccountStorage;
};

type ExchangeSuccess = {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
};

type LoadPluginOptions = {
  ccCredentials?: CCCredential[];
  config?: typeof DEFAULT_CONFIG;
  exchangeResult?: ExchangeSuccess;
  initialStorage?: AccountStorage;
};

function makeStats(lastReset = Date.now()) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lastReset,
  };
}

function makeCCCredential(overrides: Partial<CCCredential> = {}): CCCredential {
  return {
    accessToken: "cc-access-fresh",
    refreshToken: "cc-refresh-fresh",
    expiresAt: Date.now() + 3_600_000,
    source: "cc-keychain",
    label: "Claude Code-credentials:alice@example.com",
    subscriptionType: "max",
    ...overrides,
  };
}

async function loadManager(options: LoadManagerOptions = {}) {
  vi.resetModules();

  const storage = createInMemoryStorage(options.initialStorage);
  const createDefaultStats = vi.fn((now?: number) => makeStats(now ?? Date.now()));

  vi.doMock("./storage.js", async (importOriginal) => {
    const actual = await importOriginal<typeof StorageModule>();

    return {
      ...actual,
      createDefaultStats,
      loadAccounts: storage.loadAccountsMock,
      saveAccounts: storage.saveAccountsMock,
    };
  });

  vi.doMock("./cc-credentials.js", () => ({
    readCCCredentials: () => options.ccCredentials ?? [],
  }));

  const { AccountManager } = await import("./accounts.js");

  const manager = await AccountManager.load(options.config ?? DEFAULT_CONFIG, options.authFallback ?? null);

  return {
    manager,
    storage,
  };
}

function makeClient() {
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

async function loadPlugin(options: LoadPluginOptions = {}) {
  vi.resetModules();

  const storage = createInMemoryStorage(options.initialStorage);
  const createDefaultStats = vi.fn((now?: number) => makeStats(now ?? Date.now()));
  const authorizeMock = vi.fn().mockResolvedValue({
    url: "https://claude.ai/oauth/authorize?state=test-state",
    verifier: "test-verifier",
    state: "test-state",
  });
  const exchangeMock = vi.fn().mockResolvedValue(
    options.exchangeResult ?? {
      type: "success",
      refresh: "oauth-refresh-fresh",
      access: "oauth-access-fresh",
      expires: Date.now() + 3_600_000,
      email: "alice@example.com",
    },
  );

  vi.doMock("./storage.js", () => ({
    createDefaultStats,
    loadAccounts: storage.loadAccountsMock,
    saveAccounts: storage.saveAccountsMock,
    clearAccounts: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("./cc-credentials.js", () => ({
    readCCCredentials: () => options.ccCredentials ?? [],
  }));

  vi.doMock("./config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof ConfigModule>();

    return {
      ...actual,
      DEFAULT_CONFIG,
      loadConfig: vi.fn(() => ({
        ...DEFAULT_CONFIG,
        signature_emulation: {
          ...DEFAULT_CONFIG.signature_emulation,
          fetch_claude_code_version_on_startup: false,
        },
        idle_refresh: {
          ...DEFAULT_CONFIG.idle_refresh,
          enabled: false,
        },
        cc_credential_reuse: {
          ...DEFAULT_CONFIG.cc_credential_reuse,
        },
        ...(options.config ?? {}),
      })),
    };
  });

  vi.doMock("./oauth.js", () => ({
    authorize: authorizeMock,
    exchange: exchangeMock,
  }));

  vi.doMock("./commands/prompts.js", () => ({
    promptAccountMenu: vi.fn().mockResolvedValue("add"),
    promptManageAccounts: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("./bun-fetch.js", () => ({
    createBunFetch: () => ({
      fetch: vi.fn(),
    }),
  }));

  const { AnthropicAuthPlugin } = await import("./index.js");

  return {
    plugin: await AnthropicAuthPlugin({ client: makeClient() }),
    storage,
  };
}

function lastSavedStorage(storage: ReturnType<typeof createInMemoryStorage>): AccountStorage {
  const calls = (storage.saveAccountsMock as unknown as Mock).mock.calls as AccountStorage[][];
  const saved = calls[calls.length - 1]?.[0] as AccountStorage | undefined;
  expect(saved).toBeDefined();
  return saved!;
}

describe("AccountManager identity-based dedup RED", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("updates an OAuth account by email instead of creating a duplicate on refresh rotation", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-1",
        email: "alice@example.com",
        refreshToken: "oauth-refresh-old",
        access: "oauth-access-old",
        source: "oauth",
      },
    ]);

    const { manager } = await loadManager({ initialStorage });

    manager.addAccount("oauth-refresh-new", "oauth-access-new", Date.now() + 7_200_000, "alice@example.com");

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: "oauth-1",
      refreshToken: "oauth-refresh-new",
      access: "oauth-access-new",
      email: "alice@example.com",
    });
  });

  it("matches duplicates by identity rather than refresh token for OAuth accounts", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-identity",
        email: "identity@example.com",
        refreshToken: "oauth-refresh-a",
        access: "oauth-access-a",
      },
    ]);

    const { manager } = await loadManager({ initialStorage });

    const updated = manager.addAccount(
      "oauth-refresh-b",
      "oauth-access-b",
      Date.now() + 7_200_000,
      "identity@example.com",
    );

    expect(updated?.id).toBe("oauth-identity");
    expect(manager.getAccountsSnapshot()).toHaveLength(1);
  });

  it("preserves account metadata when an OAuth identity is updated", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-meta",
        email: "meta@example.com",
        refreshToken: "oauth-meta-old",
        access: "oauth-meta-access-old",
        addedAt: 1_111,
        lastUsed: 2_222,
        token_updated_at: 3_333,
        lastSwitchReason: "sticky",
        source: "oauth",
        stats: {
          requests: 9,
          inputTokens: 90,
          outputTokens: 45,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          lastReset: 4_444,
        },
      },
    ]);

    const { manager } = await loadManager({ initialStorage });

    manager.addAccount("oauth-meta-new", "oauth-meta-access-new", Date.now() + 9_000_000, "meta@example.com");

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: "oauth-meta",
      addedAt: 1_111,
      lastUsed: 2_222,
      lastSwitchReason: "sticky",
      source: "oauth",
      stats: expect.objectContaining({
        requests: 9,
        inputTokens: 90,
        outputTokens: 45,
      }),
    });
  });

  it("preserves the active index when dedup updates an existing OAuth identity", async () => {
    const initialStorage = makeAccountsData(
      [
        {
          id: "oauth-active-a",
          email: "alpha@example.com",
          refreshToken: "oauth-alpha-old",
          source: "oauth",
        },
        {
          id: "oauth-active-b",
          email: "beta@example.com",
          refreshToken: "oauth-beta",
          source: "oauth",
        },
      ],
      { activeIndex: 1 },
    );

    const { manager } = await loadManager({ initialStorage });

    manager.addAccount("oauth-alpha-new", "oauth-alpha-access-new", Date.now() + 7_200_000, "alpha@example.com");

    expect(manager.getAccountsSnapshot()).toHaveLength(2);
    expect(manager.getCurrentIndex()).toBe(1);
  });

  it("deduplicates CC accounts by source and label across rotation cycles", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "cc-1",
        refreshToken: "cc-refresh-old",
        access: "cc-access-old",
        source: "cc-keychain",
      },
    ]);

    const { manager } = await loadManager({
      initialStorage,
      ccCredentials: [
        makeCCCredential({
          refreshToken: "cc-refresh-new",
          accessToken: "cc-access-new",
          source: "cc-keychain",
          label: "Claude Code-credentials:alice@example.com",
        }),
      ],
    });

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: "cc-1",
      refreshToken: "cc-refresh-new",
      access: "cc-access-new",
      source: "cc-keychain",
    });
  });

  it("keeps OAuth and CC accounts separate even when they share an email", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-shared-email",
        email: "shared@example.com",
        refreshToken: "oauth-shared-refresh",
        source: "oauth",
      },
      {
        id: "cc-shared-email",
        refreshToken: "cc-refresh-old",
        access: "cc-access-old",
        source: "cc-keychain",
      },
    ]);

    const { manager } = await loadManager({
      initialStorage,
      ccCredentials: [
        makeCCCredential({
          refreshToken: "cc-refresh-new",
          accessToken: "cc-access-new",
          source: "cc-keychain",
          label: "Claude Code-credentials:shared@example.com",
        }),
      ],
    });

    const snapshot = manager.getAccountsSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.filter((account) => account.source === "oauth")).toHaveLength(1);
    expect(snapshot.filter((account) => account.source === "cc-keychain")).toHaveLength(1);
  });

  it("Flow A: CC auto-detect re-auth updates the existing account without creating a duplicate", async () => {
    const { plugin, storage } = await loadPlugin({
      initialStorage: makeAccountsData([
        {
          id: "cc-flow-a",
          refreshToken: "cc-refresh-stale",
          access: "cc-access-stale",
          source: "cc-keychain",
          label: "Claude Code-credentials:alice@example.com",
        },
      ]),
      ccCredentials: [
        makeCCCredential({
          refreshToken: "cc-refresh-rotated",
          accessToken: "cc-access-rotated",
          source: "cc-keychain",
          label: "Claude Code-credentials:alice@example.com",
        }),
      ],
    });

    const method = plugin.auth.methods[0];
    expect(method).toBeDefined();
    if (!method) {
      throw new Error("Expected Claude Code auth method");
    }
    expect(method.authorize).toBeTypeOf("function");
    if (!method.authorize) {
      throw new Error("Expected Claude Code authorize handler");
    }

    const credentials = await method.authorize();

    expect(credentials).toMatchObject({
      type: "success",
      refresh: "cc-refresh-rotated",
      access: "cc-access-rotated",
    });

    const saved = lastSavedStorage(storage);
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0]).toMatchObject({
      id: "cc-flow-a",
      refreshToken: "cc-refresh-rotated",
      access: "cc-access-rotated",
      source: "cc-keychain",
      label: "Claude Code-credentials:alice@example.com",
      identity: {
        kind: "cc",
        source: "cc-keychain",
        label: "Claude Code-credentials:alice@example.com",
      },
    });
  });

  it("Flow B: OAuth re-auth updates the existing account for the same email without creating a duplicate", async () => {
    const { plugin, storage } = await loadPlugin({
      initialStorage: makeAccountsData([
        {
          id: "oauth-flow-b",
          email: "alice@example.com",
          refreshToken: "oauth-refresh-stale",
          access: "oauth-access-stale",
          source: "oauth",
        },
      ]),
      exchangeResult: {
        type: "success",
        refresh: "oauth-refresh-rotated",
        access: "oauth-access-rotated",
        expires: Date.now() + 7_200_000,
        email: "alice@example.com",
      },
    });

    const method = plugin.auth.methods[1];
    expect(method).toBeDefined();
    if (!method) {
      throw new Error("Expected OAuth auth method");
    }
    expect(method.authorize).toBeTypeOf("function");
    if (!method.authorize) {
      throw new Error("Expected OAuth authorize handler");
    }

    const authResult = await method.authorize();
    expect(authResult.callback).toBeTypeOf("function");
    if (!authResult.callback) {
      throw new Error("Expected OAuth callback");
    }

    const credentials = await authResult.callback("oauth-code#test-state");

    expect(credentials).toMatchObject({
      type: "success",
      refresh: "oauth-refresh-rotated",
      access: "oauth-access-rotated",
      email: "alice@example.com",
    });

    const saved = lastSavedStorage(storage);
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0]).toMatchObject({
      id: "oauth-flow-b",
      email: "alice@example.com",
      refreshToken: "oauth-refresh-rotated",
      access: "oauth-access-rotated",
      source: "oauth",
      identity: {
        kind: "oauth",
        email: "alice@example.com",
      },
    });
  });

  it("enforces MAX_ACCOUNTS during CC auto-detect instead of overflowing capacity", async () => {
    const initialStorage = makeAccountsData(
      Array.from({ length: 10 }, (_, index) => ({
        id: `oauth-${index + 1}`,
        email: `user${index + 1}@example.com`,
        refreshToken: `oauth-refresh-${index + 1}`,
        source: "oauth" as const,
      })),
    );

    const { manager } = await loadManager({
      initialStorage,
      ccCredentials: [
        makeCCCredential({
          refreshToken: "cc-refresh-overflow",
          source: "cc-file",
          label: "/Users/test/.claude/.credentials.json",
        }),
      ],
    });

    expect(manager.getAccountsSnapshot()).toHaveLength(10);
  });

  it("preserves the source field when syncing a rotated account from disk", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "cc-sync-source",
        refreshToken: "cc-sync-old",
        access: "cc-sync-access-old",
        source: "cc-file",
      },
    ]);

    const { manager, storage } = await loadManager({ initialStorage });

    storage.mutateDiskOnly((disk) => ({
      ...disk,
      accounts: disk.accounts.map((account) => ({
        ...account,
        refreshToken: "cc-sync-new",
        access: "cc-sync-access-new",
        token_updated_at: Date.now() + 5_000,
        source: "cc-file",
      })),
    }));

    await manager.syncActiveIndexFromDisk();

    expect(manager.getAccountsSnapshot()[0]?.source).toBe("cc-file");
  });

  it("preserves in-flight object references while syncing rotated auth from disk", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-ref-preserve",
        email: "ref@example.com",
        refreshToken: "oauth-ref-old",
        access: "oauth-ref-access-old",
        source: "oauth",
      },
    ]);

    const { manager, storage } = await loadManager({ initialStorage });

    const currentAccount = manager.getCurrentAccount();
    expect(currentAccount).not.toBeNull();

    storage.mutateDiskOnly((disk) => ({
      ...disk,
      accounts: disk.accounts.map((account) => ({
        ...account,
        refreshToken: "oauth-ref-new",
        access: "oauth-ref-access-new",
        token_updated_at: Date.now() + 5_000,
      })),
    }));

    await manager.syncActiveIndexFromDisk();

    const activeAfterSync = manager.getCurrentAccount();
    expect(activeAfterSync).toBe(currentAccount);
    expect(currentAccount?.refreshToken).toBe("oauth-ref-new");
  });

  it("unions disk-only accounts during save instead of dropping them", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-save-primary",
        email: "primary@example.com",
        refreshToken: "oauth-save-primary",
        source: "oauth",
      },
    ]);

    const { manager, storage } = await loadManager({ initialStorage });

    storage.mutateDiskOnly((disk) => ({
      ...disk,
      accounts: [
        ...disk.accounts,
        makeStoredAccount({
          id: "oauth-disk-only",
          email: "disk-only@example.com",
          refreshToken: "oauth-disk-only",
          source: "oauth",
          addedAt: 9_999,
          stats: makeStats(9_999),
        }),
      ],
    }));

    await manager.saveToDisk();

    const saved = lastSavedStorage(storage);
    expect(saved.accounts.map((account) => account.id).sort()).toEqual(["oauth-disk-only", "oauth-save-primary"]);
  });

  it("does not lose disk-only accounts on repeated saves", async () => {
    const initialStorage = makeAccountsData([
      {
        id: "oauth-repeat-primary",
        email: "repeat-primary@example.com",
        refreshToken: "oauth-repeat-primary",
        source: "oauth",
      },
    ]);

    const { manager, storage } = await loadManager({ initialStorage });

    storage.mutateDiskOnly((disk) => ({
      ...disk,
      accounts: [
        ...disk.accounts,
        makeStoredAccount({
          id: "oauth-repeat-disk-only",
          email: "repeat-disk-only@example.com",
          refreshToken: "oauth-repeat-disk-only",
          source: "oauth",
          addedAt: 8_888,
          stats: makeStats(8_888),
        }),
      ],
    }));

    await manager.saveToDisk();
    await manager.saveToDisk();

    const saved = lastSavedStorage(storage);
    expect(saved.accounts.map((account) => account.id).sort()).toEqual([
      "oauth-repeat-disk-only",
      "oauth-repeat-primary",
    ]);
  });

  it("keeps the same active account when disk-only unions shift array positions", async () => {
    const initialStorage = makeAccountsData(
      [
        {
          id: "oauth-active-keep",
          email: "active@example.com",
          refreshToken: "oauth-active-keep",
          source: "oauth",
        },
      ],
      { activeIndex: 0 },
    );

    const { manager, storage } = await loadManager({ initialStorage });

    storage.mutateDiskOnly((disk) => ({
      ...disk,
      accounts: [
        makeStoredAccount({
          id: "oauth-prepended-disk-only",
          email: "prepended@example.com",
          refreshToken: "oauth-prepended-disk-only",
          source: "oauth",
          addedAt: 777,
          stats: makeStats(777),
        }),
        ...disk.accounts,
      ],
    }));

    await manager.saveToDisk();

    const saved = lastSavedStorage(storage);
    expect(saved.accounts[saved.activeIndex]?.id).toBe("oauth-active-keep");
  });
});
