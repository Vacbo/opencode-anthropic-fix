import type { RateLimitReason } from "./backoff.js";
import { calculateBackoffMs } from "./backoff.js";
import { readCCCredentials } from "./cc-credentials.js";
import {
  findByIdentity,
  resolveIdentity,
  resolveIdentityFromCCCredential,
  type AccountIdentity,
} from "./account-identity.js";
import type { AnthropicAuthConfig } from "./config.js";
import { HealthScoreTracker, selectAccount, TokenBucketTracker } from "./rotation.js";
import type { AccountMetadata, AccountStats, AccountStorage } from "./storage.js";
import { createDefaultStats, loadAccounts, saveAccounts } from "./storage.js";

export interface ManagedAccount {
  id: string;
  index: number;
  email?: string;
  identity?: AccountIdentity;
  label?: string;
  refreshToken: string;
  access?: string;
  expires?: number;
  tokenUpdatedAt: number;
  addedAt: number;
  lastUsed: number;
  enabled: boolean;
  rateLimitResetTimes: Record<string, number>;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  lastSwitchReason?: string;
  stats: AccountStats;
  source?: "cc-keychain" | "cc-file" | "oauth";
}

export interface StatsDelta {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** If true, this delta represents an absolute reset, not an increment */
  isReset: boolean;
  /** The lastReset value when isReset is true */
  resetTimestamp?: number;
}

const MAX_ACCOUNTS = 10;
const RATE_LIMIT_KEY = "anthropic";

type ManagedAccountSource = ManagedAccount["source"];

type AddAccountOptions = {
  identity?: AccountIdentity;
  label?: string;
  source?: ManagedAccountSource;
};

type ManagedAccountInit = {
  id?: string;
  index: number;
  email?: string;
  identity?: AccountIdentity;
  label?: string;
  refreshToken: string;
  access?: string;
  expires?: number;
  tokenUpdatedAt?: number;
  addedAt?: number;
  lastUsed?: number;
  enabled?: boolean;
  rateLimitResetTimes?: Record<string, number>;
  consecutiveFailures?: number;
  lastFailureTime?: number | null;
  lastSwitchReason?: string;
  stats?: AccountStats;
  source?: ManagedAccountSource;
  now?: number;
};

function resolveAccountIdentity(params: {
  refreshToken: string;
  email?: string;
  identity?: AccountIdentity;
  label?: string;
  source?: ManagedAccountSource;
}): AccountIdentity {
  if (params.identity) {
    return params.identity;
  }

  if ((params.source === "cc-keychain" || params.source === "cc-file") && params.label) {
    return {
      kind: "cc",
      source: params.source,
      label: params.label,
    };
  }

  if (params.email) {
    return {
      kind: "oauth",
      email: params.email,
    };
  }

  return {
    kind: "legacy",
    refreshToken: params.refreshToken,
  };
}

function createManagedAccount(init: ManagedAccountInit): ManagedAccount {
  const now = init.now ?? Date.now();
  const addedAt = init.addedAt ?? now;
  const tokenUpdatedAt = init.tokenUpdatedAt ?? addedAt;
  const identity = resolveAccountIdentity({
    refreshToken: init.refreshToken,
    email: init.email,
    identity: init.identity,
    label: init.label,
    source: init.source,
  });
  const email = init.email ?? (identity.kind === "oauth" ? identity.email : undefined);
  const label = init.label ?? (identity.kind === "cc" ? identity.label : undefined);
  const source = init.source ?? (identity.kind === "cc" ? identity.source : "oauth");

  return {
    id: init.id ?? `${addedAt}:${init.refreshToken.slice(0, 12)}`,
    index: init.index,
    email,
    identity,
    label,
    refreshToken: init.refreshToken,
    access: init.access,
    expires: init.expires,
    tokenUpdatedAt,
    addedAt,
    lastUsed: init.lastUsed ?? 0,
    enabled: init.enabled ?? true,
    rateLimitResetTimes: { ...(init.rateLimitResetTimes ?? {}) },
    consecutiveFailures: init.consecutiveFailures ?? 0,
    lastFailureTime: init.lastFailureTime ?? null,
    lastSwitchReason: init.lastSwitchReason ?? "initial",
    stats: init.stats ?? createDefaultStats(addedAt),
    source,
  };
}

function findMatchingAccount(
  accounts: ManagedAccount[],
  params: {
    id?: string;
    identity?: AccountIdentity;
    refreshToken?: string;
  },
): ManagedAccount | null {
  if (params.id) {
    const byId = accounts.find((account) => account.id === params.id);
    if (byId) return byId;
  }

  if (params.identity) {
    const byIdentity = findByIdentity(accounts, params.identity);
    if (byIdentity) return byIdentity;
  }

  if (params.refreshToken) {
    return accounts.find((account) => account.refreshToken === params.refreshToken) ?? null;
  }

  return null;
}

function reindexAccounts(accounts: ManagedAccount[]): void {
  accounts.forEach((account, index) => {
    account.index = index;
  });
}

function updateManagedAccountFromStorage(existing: ManagedAccount, account: AccountMetadata, index: number): void {
  const source = account.source || existing.source || "oauth";
  const label = account.label ?? existing.label;
  const email = account.email ?? existing.email;

  existing.id = account.id || existing.id || `${account.addedAt}:${account.refreshToken.slice(0, 12)}`;
  existing.index = index;
  existing.email = email;
  existing.label = label;
  existing.identity = resolveAccountIdentity({
    refreshToken: account.refreshToken,
    email,
    identity: account.identity ?? existing.identity,
    label,
    source,
  });
  existing.refreshToken = account.refreshToken;
  existing.access = account.access ?? existing.access;
  existing.expires = account.expires ?? existing.expires;
  existing.tokenUpdatedAt = account.token_updated_at ?? existing.tokenUpdatedAt ?? account.addedAt;
  existing.addedAt = account.addedAt;
  existing.lastUsed = account.lastUsed;
  existing.enabled = account.enabled;
  existing.rateLimitResetTimes = { ...account.rateLimitResetTimes };
  existing.consecutiveFailures = account.consecutiveFailures;
  existing.lastFailureTime = account.lastFailureTime;
  existing.lastSwitchReason = account.lastSwitchReason || existing.lastSwitchReason || "initial";
  existing.stats = account.stats ?? existing.stats ?? createDefaultStats(account.addedAt);
  existing.source = source;
}

export class AccountManager {
  #accounts: ManagedAccount[] = [];
  #cursor = 0;
  #currentIndex = -1;
  #healthTracker: HealthScoreTracker;
  #tokenTracker: TokenBucketTracker;
  #config: AnthropicAuthConfig;
  #saveTimeout: ReturnType<typeof setTimeout> | null = null;
  #statsDeltas = new Map<string, StatsDelta>();
  /**
   * Cap on pending stats deltas. When hit, a forced flush is scheduled so the
   * map does not grow without bound between debounced saves. This is only a
   * safety net — under normal load the 1s debounced save in `requestSaveToDisk`
   * keeps the delta count below this cap.
   */
  readonly #MAX_STATS_DELTAS = 100;

  constructor(config: AnthropicAuthConfig) {
    this.#config = config;
    this.#healthTracker = new HealthScoreTracker(config.health_score);
    this.#tokenTracker = new TokenBucketTracker(config.token_bucket);
  }

  #rebuildTrackers(): void {
    this.#healthTracker = new HealthScoreTracker(this.#config.health_score);
    this.#tokenTracker = new TokenBucketTracker(this.#config.token_bucket);
  }

  /**
   * Load accounts from disk, optionally merging with an OpenCode auth fallback.
   */
  static async load(
    config: AnthropicAuthConfig,
    authFallback?: {
      refresh: string;
      access?: string;
      expires?: number;
    } | null,
  ): Promise<AccountManager> {
    const manager = new AccountManager(config);
    const stored = await loadAccounts();

    // If storage exists (even with zero accounts), treat disk as authoritative.
    if (stored) {
      manager.#accounts = stored.accounts.map((acc, index) =>
        createManagedAccount({
          id: acc.id || `${acc.addedAt}:${acc.refreshToken.slice(0, 12)}`,
          index,
          email: acc.email,
          identity: acc.identity,
          label: acc.label,
          refreshToken: acc.refreshToken,
          access: acc.access,
          expires: acc.expires,
          tokenUpdatedAt: acc.token_updated_at,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          enabled: acc.enabled,
          rateLimitResetTimes: acc.rateLimitResetTimes,
          consecutiveFailures: acc.consecutiveFailures,
          lastFailureTime: acc.lastFailureTime,
          lastSwitchReason: acc.lastSwitchReason,
          stats: acc.stats,
          source: acc.source || "oauth",
        }),
      );

      manager.#currentIndex =
        manager.#accounts.length > 0 ? Math.min(stored.activeIndex, manager.#accounts.length - 1) : -1;

      if (authFallback && manager.#accounts.length > 0) {
        const fallbackIdentity = resolveAccountIdentity({
          refreshToken: authFallback.refresh,
          source: "oauth",
        });
        const match = findMatchingAccount(manager.#accounts, {
          identity: fallbackIdentity,
          refreshToken: authFallback.refresh,
        });
        if (match) {
          const fallbackHasAccess = typeof authFallback.access === "string" && authFallback.access.length > 0;
          const fallbackExpires = typeof authFallback.expires === "number" ? authFallback.expires : 0;
          const matchExpires = typeof match.expires === "number" ? match.expires : 0;
          const fallbackLooksFresh = fallbackHasAccess && fallbackExpires > Date.now();
          const shouldAdoptFallback =
            fallbackLooksFresh && (!match.access || !match.expires || fallbackExpires > matchExpires);
          if (shouldAdoptFallback) {
            match.access = authFallback.access;
            match.expires = authFallback.expires;
            match.tokenUpdatedAt = Math.max(match.tokenUpdatedAt || 0, fallbackExpires);
          }
        }
      }

      // No stored accounts — bootstrap from fallback if available
    } else if (authFallback && authFallback.refresh) {
      const now = Date.now();
      manager.#accounts = [
        createManagedAccount({
          id: `${now}:${authFallback.refresh.slice(0, 12)}`,
          index: 0,
          refreshToken: authFallback.refresh,
          access: authFallback.access,
          expires: authFallback.expires,
          tokenUpdatedAt: now,
          addedAt: now,
          lastSwitchReason: "initial",
          source: "oauth",
        }),
      ];
      manager.#currentIndex = 0;
    }

    if (config.cc_credential_reuse?.enabled && config.cc_credential_reuse?.auto_detect) {
      const currentAccountId = manager.#accounts[manager.#currentIndex]?.id ?? null;
      const ccCredentials: ReturnType<typeof readCCCredentials> = (() => {
        try {
          return readCCCredentials();
        } catch {
          return [];
        }
      })();

      for (const ccCredential of ccCredentials) {
        const ccIdentity = resolveIdentityFromCCCredential(ccCredential);
        let existingMatch = findMatchingAccount(manager.#accounts, {
          identity: ccIdentity,
          refreshToken: ccCredential.refreshToken,
        });

        if (!existingMatch) {
          const legacyUnlabeledMatches = manager.#accounts.filter(
            (account) => account.source === ccCredential.source && !account.label && !account.email,
          );
          if (legacyUnlabeledMatches.length === 1) {
            existingMatch = legacyUnlabeledMatches[0]!;
          }
        }

        if (existingMatch) {
          existingMatch.refreshToken = ccCredential.refreshToken;
          existingMatch.identity = ccIdentity;
          existingMatch.source = ccCredential.source;
          existingMatch.label = ccCredential.label;
          existingMatch.enabled = true;
          if (ccCredential.accessToken) {
            existingMatch.access = ccCredential.accessToken;
          }
          if (ccCredential.expiresAt >= (existingMatch.expires ?? 0)) {
            existingMatch.expires = ccCredential.expiresAt;
          }
          existingMatch.tokenUpdatedAt = Math.max(existingMatch.tokenUpdatedAt || 0, ccCredential.expiresAt || 0);
          continue;
        }

        if (manager.#accounts.length >= MAX_ACCOUNTS) {
          continue;
        }

        const emailCollision = manager
          .getOAuthAccounts()
          .find((account) => account.email && ccCredential.label.includes(account.email));
        if (emailCollision?.email) {
          // Duplicate detection: CC credential may match existing OAuth account
          // This is informational only - both accounts are kept
        }

        const now = Date.now();
        const ccAccount = createManagedAccount({
          id: `cc-${ccCredential.source}-${now}:${ccCredential.refreshToken.slice(0, 12)}`,
          index: manager.#accounts.length,
          refreshToken: ccCredential.refreshToken,
          access: ccCredential.accessToken,
          expires: ccCredential.expiresAt,
          tokenUpdatedAt: now,
          addedAt: now,
          identity: ccIdentity,
          label: ccCredential.label,
          lastSwitchReason: "cc-auto-detected",
          source: ccCredential.source,
        });

        manager.#accounts.push(ccAccount);
      }

      if (config.cc_credential_reuse.prefer_over_oauth && manager.getCCAccounts().length > 0) {
        manager.#accounts = [...manager.getCCAccounts(), ...manager.getOAuthAccounts()];
      }

      reindexAccounts(manager.#accounts);

      if (config.cc_credential_reuse.prefer_over_oauth && manager.getCCAccounts().length > 0) {
        manager.#currentIndex = 0;
      } else if (currentAccountId) {
        manager.#currentIndex = manager.#accounts.findIndex((account) => account.id === currentAccountId);
      } else if (manager.#currentIndex < 0 && manager.#accounts.length > 0) {
        manager.#currentIndex = 0;
      }
    }

    return manager;
  }

  /**
   * Get the number of enabled accounts.
   */
  getAccountCount(): number {
    return this.#accounts.filter((acc) => acc.enabled).length;
  }

  /**
   * Get the total number of accounts (including disabled).
   */
  getTotalAccountCount(): number {
    return this.#accounts.length;
  }

  /**
   * Get a snapshot of all accounts (for display/management).
   */
  getAccountsSnapshot(): ManagedAccount[] {
    return this.#accounts.map((acc) => ({ ...acc }));
  }

  /**
   * Get the current active account index.
   */
  getCurrentIndex(): number {
    return this.#currentIndex;
  }

  /**
   * Force the active account to a specific index.
   * Used by OPENCODE_ANTHROPIC_INITIAL_ACCOUNT to pin a session to one account.
   */
  forceCurrentIndex(index: number): boolean {
    const account = this.#accounts[index];
    if (!account || !account.enabled) return false;
    this.#currentIndex = index;
    this.#cursor = index;
    return true;
  }

  /**
   * Get enabled account references for internal plugin operations.
   */
  getEnabledAccounts(excludedIndices?: Set<number>): ManagedAccount[] {
    return this.#accounts.filter((acc) => acc.enabled && !excludedIndices?.has(acc.index));
  }

  getCCAccounts(): ManagedAccount[] {
    return this.#accounts.filter((acc) => acc.source === "cc-keychain" || acc.source === "cc-file");
  }

  getOAuthAccounts(): ManagedAccount[] {
    return this.#accounts.filter((acc) => !acc.source || acc.source === "oauth");
  }

  #clearExpiredRateLimits(account: ManagedAccount): void {
    const now = Date.now();
    for (const key of Object.keys(account.rateLimitResetTimes)) {
      if (account.rateLimitResetTimes[key]! <= now) {
        delete account.rateLimitResetTimes[key];
      }
    }
  }

  #isRateLimited(account: ManagedAccount): boolean {
    this.#clearExpiredRateLimits(account);
    const resetTime = account.rateLimitResetTimes[RATE_LIMIT_KEY];
    return resetTime !== undefined && Date.now() < resetTime;
  }

  /**
   * Select the best account for the current request.
   */
  getCurrentAccount(excludedIndices?: Set<number>): ManagedAccount | null {
    if (this.#accounts.length === 0) return null;

    const candidates = this.#accounts
      .filter((acc) => acc.enabled && !excludedIndices?.has(acc.index))
      .map((acc) => {
        this.#clearExpiredRateLimits(acc);
        return {
          index: acc.index,
          lastUsed: acc.lastUsed,
          healthScore: this.#healthTracker.getScore(acc.index),
          isRateLimited: this.#isRateLimited(acc),
          enabled: acc.enabled,
        };
      });

    const result = selectAccount(
      candidates,
      this.#config.account_selection_strategy,
      this.#currentIndex >= 0 ? this.#currentIndex : null,
      this.#healthTracker,
      this.#tokenTracker,
      this.#cursor,
    );

    if (!result) return null;

    this.#cursor = result.cursor;
    this.#currentIndex = result.index;

    const account = this.#accounts[result.index];
    if (account) {
      account.lastUsed = Date.now();
      this.#tokenTracker.consume(account.index);
    }

    return account ?? null;
  }

  /**
   * Mark an account as rate-limited.
   * @returns The backoff duration in ms
   */
  markRateLimited(account: ManagedAccount, reason: RateLimitReason, retryAfterMs?: number | null): number {
    const now = Date.now();

    if (account.lastFailureTime !== null && now - account.lastFailureTime > this.#config.failure_ttl_seconds * 1000) {
      account.consecutiveFailures = 0;
    }

    account.consecutiveFailures += 1;
    account.lastFailureTime = now;

    const backoffMs = calculateBackoffMs(reason, account.consecutiveFailures - 1, retryAfterMs);

    account.rateLimitResetTimes[RATE_LIMIT_KEY] = now + backoffMs;

    this.#healthTracker.recordRateLimit(account.index);

    this.requestSaveToDisk();

    return backoffMs;
  }

  /**
   * Mark a successful request for an account.
   */
  markSuccess(account: ManagedAccount): void {
    account.consecutiveFailures = 0;
    account.lastFailureTime = null;
    this.#healthTracker.recordSuccess(account.index);
  }

  /**
   * Mark a general failure (not rate limit) for an account.
   */
  markFailure(account: ManagedAccount): void {
    this.#healthTracker.recordFailure(account.index);
    this.#tokenTracker.refund(account.index);
  }

  /**
   * Add a new account to the pool.
   * @returns The new account, or null if at capacity
   */
  addAccount(
    refreshToken: string,
    accessToken: string,
    expires: number,
    email?: string,
    options?: AddAccountOptions,
  ): ManagedAccount | null {
    const identity = resolveAccountIdentity({
      refreshToken,
      email,
      identity: options?.identity,
      label: options?.label,
      source: options?.source ?? "oauth",
    });
    const existing = findMatchingAccount(this.#accounts, {
      identity,
      refreshToken,
    });

    if (existing) {
      existing.refreshToken = refreshToken;
      existing.access = accessToken;
      existing.expires = expires;
      existing.tokenUpdatedAt = Date.now();
      existing.email = email ?? existing.email;
      existing.identity = identity;
      existing.label = options?.label ?? existing.label;
      existing.source = options?.source ?? existing.source ?? "oauth";
      existing.enabled = true;
      this.requestSaveToDisk();
      return existing;
    }

    if (this.#accounts.length >= MAX_ACCOUNTS) return null;

    const now = Date.now();
    const account = createManagedAccount({
      id: `${now}:${refreshToken.slice(0, 12)}`,
      index: this.#accounts.length,
      refreshToken,
      access: accessToken,
      expires,
      tokenUpdatedAt: now,
      addedAt: now,
      lastSwitchReason: "initial",
      email,
      identity,
      label: options?.label,
      source: options?.source ?? "oauth",
    });

    this.#accounts.push(account);

    if (this.#accounts.length === 1) {
      this.#currentIndex = 0;
    }

    this.requestSaveToDisk();
    return account;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index: number): boolean {
    if (index < 0 || index >= this.#accounts.length) return false;

    this.#accounts.splice(index, 1);

    reindexAccounts(this.#accounts);

    if (this.#accounts.length === 0) {
      this.#currentIndex = -1;
      this.#cursor = 0;
    } else {
      if (this.#currentIndex >= this.#accounts.length) {
        this.#currentIndex = this.#accounts.length - 1;
      }
      if (this.#cursor > 0) {
        this.#cursor = Math.min(this.#cursor, this.#accounts.length);
      }
    }

    this.#rebuildTrackers();
    this.requestSaveToDisk();
    return true;
  }

  /**
   * Toggle an account's enabled state.
   * @returns New enabled state
   */
  toggleAccount(index: number): boolean {
    const account = this.#accounts[index];
    if (!account) return false;

    account.enabled = !account.enabled;
    this.requestSaveToDisk();
    return account.enabled;
  }

  /**
   * Clear all accounts and reset state.
   */
  clearAll(): void {
    this.#accounts = [];
    this.#currentIndex = -1;
    this.#cursor = 0;
  }

  /**
   * Request a debounced save to disk.
   */
  requestSaveToDisk(): void {
    if (this.#saveTimeout) clearTimeout(this.#saveTimeout);
    this.#saveTimeout = setTimeout(() => {
      this.#saveTimeout = null;
      this.saveToDisk().catch((err) => {
        if (this.#config.debug) {
          // eslint-disable-next-line no-console -- debug-gated stderr logging; plugin has no dedicated logger
          console.error("[opencode-anthropic-auth] saveToDisk failed:", (err as Error).message);
        }
      });
    }, 1000);
  }

  /**
   * Persist current state to disk immediately.
   * Stats use merge-on-save: read disk values, add this instance's deltas,
   * write merged result.
   */
  async saveToDisk(): Promise<void> {
    let diskAccountsById: Map<string, AccountMetadata> | null = null;
    let diskAccountsByAddedAt: Map<number, AccountMetadata[]> | null = null;
    let diskAccountsByRefreshToken: Map<string, AccountMetadata> | null = null;
    let diskAccounts: AccountMetadata[] = [];
    try {
      const diskData = await loadAccounts();
      if (diskData) {
        diskAccounts = diskData.accounts;
        diskAccountsById = new Map(diskData.accounts.map((a) => [a.id, a]));
        diskAccountsByAddedAt = new Map();
        diskAccountsByRefreshToken = new Map();
        for (const diskAcc of diskData.accounts) {
          const bucket = diskAccountsByAddedAt.get(diskAcc.addedAt) || [];
          bucket.push(diskAcc);
          diskAccountsByAddedAt.set(diskAcc.addedAt, bucket);
          diskAccountsByRefreshToken.set(diskAcc.refreshToken, diskAcc);
        }
      }
    } catch {
      // If we can't read, fall through to writing absolute values
    }

    const findDiskAccount = (account: ManagedAccount): AccountMetadata | null => {
      const byId = diskAccountsById?.get(account.id);
      if (byId) return byId;

      const byIdentity = findByIdentity(diskAccounts, resolveIdentity(account));
      if (byIdentity) return byIdentity;

      const byAddedAt = diskAccountsByAddedAt?.get(account.addedAt);
      if (byAddedAt?.length === 1) return byAddedAt[0]!;

      const byToken = diskAccountsByRefreshToken?.get(account.refreshToken);
      if (byToken) return byToken;

      if (byAddedAt && byAddedAt.length > 0) return byAddedAt[0]!;
      return null;
    };

    const matchedDiskAccounts = new Set<AccountMetadata>();
    const activeAccountId = this.#accounts[this.#currentIndex]?.id ?? null;
    const accountsToPersist = this.#accounts.filter((account) => account.enabled || !!findDiskAccount(account));

    const persistedAccounts = accountsToPersist.map((acc) => {
      const delta = this.#statsDeltas.get(acc.id);
      let mergedStats = acc.stats;
      const diskAcc = findDiskAccount(acc);

      if (diskAcc) {
        matchedDiskAccounts.add(diskAcc);
      }

      if (delta) {
        const diskStats = diskAcc?.stats;

        if (delta.isReset) {
          mergedStats = {
            requests: delta.requests,
            inputTokens: delta.inputTokens,
            outputTokens: delta.outputTokens,
            cacheReadTokens: delta.cacheReadTokens,
            cacheWriteTokens: delta.cacheWriteTokens,
            lastReset: delta.resetTimestamp ?? acc.stats.lastReset,
          };
        } else if (diskStats) {
          mergedStats = {
            requests: diskStats.requests + delta.requests,
            inputTokens: diskStats.inputTokens + delta.inputTokens,
            outputTokens: diskStats.outputTokens + delta.outputTokens,
            cacheReadTokens: diskStats.cacheReadTokens + delta.cacheReadTokens,
            cacheWriteTokens: diskStats.cacheWriteTokens + delta.cacheWriteTokens,
            lastReset: diskStats.lastReset,
          };
        }
      }

      const memTokenUpdatedAt = acc.tokenUpdatedAt || 0;
      const diskTokenUpdatedAt = diskAcc?.token_updated_at || 0;
      const freshestAuth =
        diskAcc && diskTokenUpdatedAt > memTokenUpdatedAt
          ? {
              refreshToken: diskAcc.refreshToken,
              access: diskAcc.access,
              expires: diskAcc.expires,
              tokenUpdatedAt: diskTokenUpdatedAt,
            }
          : {
              refreshToken: acc.refreshToken,
              access: acc.access,
              expires: acc.expires,
              tokenUpdatedAt: memTokenUpdatedAt,
            };

      acc.refreshToken = freshestAuth.refreshToken;
      acc.access = freshestAuth.access;
      acc.expires = freshestAuth.expires;
      acc.tokenUpdatedAt = freshestAuth.tokenUpdatedAt;

      return {
        id: acc.id,
        email: acc.email,
        identity: acc.identity,
        label: acc.label,
        refreshToken: freshestAuth.refreshToken,
        access: freshestAuth.access,
        expires: freshestAuth.expires,
        token_updated_at: freshestAuth.tokenUpdatedAt,
        addedAt: acc.addedAt,
        lastUsed: acc.lastUsed,
        enabled: acc.enabled,
        rateLimitResetTimes: Object.keys(acc.rateLimitResetTimes).length > 0 ? acc.rateLimitResetTimes : {},
        consecutiveFailures: acc.consecutiveFailures,
        lastFailureTime: acc.lastFailureTime,
        lastSwitchReason: acc.lastSwitchReason,
        stats: mergedStats,
        source: acc.source,
      };
    });

    const diskOnlyAccounts = diskAccounts.filter((account) => !matchedDiskAccounts.has(account));
    const allAccounts = [...persistedAccounts, ...diskOnlyAccounts];
    const resolvedActiveIndex = activeAccountId
      ? allAccounts.findIndex((account) => account.id === activeAccountId)
      : -1;

    const storage: AccountStorage = {
      version: 1,
      accounts: allAccounts,
      activeIndex:
        resolvedActiveIndex >= 0
          ? resolvedActiveIndex
          : allAccounts.length > 0
            ? Math.max(0, Math.min(this.#currentIndex, allAccounts.length - 1))
            : 0,
    };

    await saveAccounts(storage);

    this.#statsDeltas.clear();

    for (const saved of storage.accounts) {
      const acc = this.#accounts.find((a) => a.id === saved.id);
      if (acc) {
        acc.stats = saved.stats;
      }
    }
  }

  /**
   * Sync activeIndex from disk (picks up CLI changes while OpenCode is running).
   */
  async syncActiveIndexFromDisk(): Promise<void> {
    const stored = await loadAccounts();
    if (!stored) return;

    const matchedAccounts = new Set<ManagedAccount>();
    const reconciledAccounts: ManagedAccount[] = [];
    let structuralChange = false;

    for (const [index, storedAccount] of stored.accounts.entries()) {
      const existing = findMatchingAccount(this.#accounts, {
        id: storedAccount.id,
        identity: resolveIdentity(storedAccount),
        refreshToken: storedAccount.refreshToken,
      });

      if (existing) {
        updateManagedAccountFromStorage(existing, storedAccount, index);
        matchedAccounts.add(existing);
        reconciledAccounts.push(existing);
        continue;
      }

      const addedAccount = createManagedAccount({
        id: storedAccount.id,
        index,
        email: storedAccount.email,
        identity: storedAccount.identity,
        label: storedAccount.label,
        refreshToken: storedAccount.refreshToken,
        access: storedAccount.access,
        expires: storedAccount.expires,
        tokenUpdatedAt: storedAccount.token_updated_at,
        addedAt: storedAccount.addedAt,
        lastUsed: storedAccount.lastUsed,
        enabled: storedAccount.enabled,
        rateLimitResetTimes: storedAccount.rateLimitResetTimes,
        consecutiveFailures: storedAccount.consecutiveFailures,
        lastFailureTime: storedAccount.lastFailureTime,
        lastSwitchReason: storedAccount.lastSwitchReason,
        stats: storedAccount.stats,
        source: storedAccount.source || "oauth",
      });
      matchedAccounts.add(addedAccount);
      reconciledAccounts.push(addedAccount);
      structuralChange = true;
    }

    for (const account of this.#accounts) {
      if (matchedAccounts.has(account)) {
        continue;
      }

      if (account.enabled) {
        account.enabled = false;
        structuralChange = true;
      }

      reconciledAccounts.push(account);
    }

    const orderChanged =
      reconciledAccounts.length !== this.#accounts.length ||
      reconciledAccounts.some((account, index) => this.#accounts[index] !== account);

    this.#accounts = reconciledAccounts;
    reindexAccounts(this.#accounts);

    if (orderChanged || structuralChange) {
      this.#rebuildTrackers();
    }

    const currentIds = new Set(this.#accounts.map((account) => account.id));
    for (const id of this.#statsDeltas.keys()) {
      if (!currentIds.has(id)) {
        this.#statsDeltas.delete(id);
      }
    }

    const enabledAccounts = this.#accounts.filter((account) => account.enabled);
    if (enabledAccounts.length === 0) {
      this.#currentIndex = -1;
      this.#cursor = 0;
      return;
    }

    const diskIndex = Math.min(stored.activeIndex, stored.accounts.length - 1);
    const diskAccount = diskIndex >= 0 ? stored.accounts[diskIndex] : undefined;
    if (!diskAccount || !diskAccount.enabled) {
      if (!this.#accounts[this.#currentIndex]?.enabled) {
        const fallback = enabledAccounts[0]!;
        this.#currentIndex = fallback.index;
        this.#cursor = fallback.index;
      }
      return;
    }

    const activeAccount = findMatchingAccount(this.#accounts, {
      id: diskAccount.id,
      identity: resolveIdentity(diskAccount),
      refreshToken: diskAccount.refreshToken,
    });

    if (activeAccount && activeAccount.enabled && activeAccount.index !== this.#currentIndex) {
      this.#currentIndex = activeAccount.index;
      this.#cursor = activeAccount.index;
      this.#healthTracker.reset(activeAccount.index);
    }
  }

  /**
   * Record token usage for an account after a successful API response.
   */
  recordUsage(
    index: number,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ): void {
    const account = this.#accounts[index];
    if (!account) return;

    const inTok = usage.inputTokens || 0;
    const outTok = usage.outputTokens || 0;
    const crTok = usage.cacheReadTokens || 0;
    const cwTok = usage.cacheWriteTokens || 0;

    account.stats.requests += 1;
    account.stats.inputTokens += inTok;
    account.stats.outputTokens += outTok;
    account.stats.cacheReadTokens += crTok;
    account.stats.cacheWriteTokens += cwTok;

    const delta = this.#statsDeltas.get(account.id);
    if (delta) {
      delta.requests += 1;
      delta.inputTokens += inTok;
      delta.outputTokens += outTok;
      delta.cacheReadTokens += crTok;
      delta.cacheWriteTokens += cwTok;
    } else {
      if (this.#statsDeltas.size >= this.#MAX_STATS_DELTAS) {
        this.saveToDisk().catch((err) => {
          if (this.#config.debug) {
            // eslint-disable-next-line no-console -- debug-gated stderr logging; plugin has no dedicated logger
            console.error("[opencode-anthropic-auth] forced statsDeltas flush failed:", (err as Error).message);
          }
        });
      }
      this.#statsDeltas.set(account.id, {
        requests: 1,
        inputTokens: inTok,
        outputTokens: outTok,
        cacheReadTokens: crTok,
        cacheWriteTokens: cwTok,
        isReset: false,
      });
    }

    this.requestSaveToDisk();
  }

  /**
   * Reset stats for a specific account or all accounts.
   */
  resetStats(target: number | "all"): void {
    const now = Date.now();
    const resetAccount = (acc: ManagedAccount) => {
      acc.stats = createDefaultStats(now);
      this.#statsDeltas.set(acc.id, {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        isReset: true,
        resetTimestamp: now,
      });
    };

    if (target === "all") {
      for (const acc of this.#accounts) {
        resetAccount(acc);
      }
    } else {
      const account = this.#accounts[target];
      if (account) {
        resetAccount(account);
      }
    }
    this.requestSaveToDisk();
  }

  /**
   * Convert a managed account to the format expected by OpenCode's auth.json.
   */
  toAuthDetails(account: ManagedAccount): {
    type: "oauth";
    refresh: string;
    access: string | undefined;
    expires: number | undefined;
  } {
    return {
      type: "oauth",
      refresh: account.refreshToken,
      access: account.access,
      expires: account.expires,
    };
  }
}
