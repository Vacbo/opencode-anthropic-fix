import type { RateLimitReason } from "./backoff.js";
import { calculateBackoffMs } from "./backoff.js";
import { readCCCredentials } from "./cc-credentials.js";
import type { AnthropicAuthConfig } from "./config.js";
import { HealthScoreTracker, selectAccount, TokenBucketTracker } from "./rotation.js";
import type { AccountMetadata, AccountStorage } from "./storage.js";
import { createDefaultStats, loadAccounts, saveAccounts } from "./storage.js";

export interface ManagedAccount {
  id: string;
  index: number;
  email?: string;
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
  stats: import("./storage.js").AccountStats;
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
      manager.#accounts = stored.accounts.map((acc, index) => ({
        id: acc.id || `${acc.addedAt}:${acc.refreshToken.slice(0, 12)}`,
        index,
        email: acc.email,
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
        stats: acc.stats ?? createDefaultStats(acc.addedAt),
        source: acc.source || "oauth",
      }));

      manager.#currentIndex =
        manager.#accounts.length > 0 ? Math.min(stored.activeIndex, manager.#accounts.length - 1) : -1;

      if (authFallback && manager.#accounts.length > 0) {
        const match = manager.#accounts.find((acc) => acc.refreshToken === authFallback.refresh);
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
        {
          id: `${now}:${authFallback.refresh.slice(0, 12)}`,
          index: 0,
          email: undefined,
          refreshToken: authFallback.refresh,
          access: authFallback.access,
          expires: authFallback.expires,
          tokenUpdatedAt: now,
          addedAt: now,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          lastSwitchReason: "initial",
          stats: createDefaultStats(now),
        },
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
        const existingMatch = manager.#accounts.find((account) => account.refreshToken === ccCredential.refreshToken);
        if (existingMatch) {
          // Adopt CC source tag so getCCAccounts() recognizes it
          if (!existingMatch.source || existingMatch.source === "oauth") {
            existingMatch.source = ccCredential.source;
          }
          // Adopt fresh access token from CC if available
          if (ccCredential.accessToken && ccCredential.expiresAt > (existingMatch.expires ?? 0)) {
            existingMatch.access = ccCredential.accessToken;
            existingMatch.expires = ccCredential.expiresAt;
          }
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
        const ccAccount: ManagedAccount = {
          id: `cc-${ccCredential.source}-${now}:${ccCredential.refreshToken.slice(0, 12)}`,
          index: manager.#accounts.length,
          email: undefined,
          refreshToken: ccCredential.refreshToken,
          access: ccCredential.accessToken,
          expires: ccCredential.expiresAt,
          tokenUpdatedAt: now,
          addedAt: now,
          lastUsed: 0,
          enabled: true,
          rateLimitResetTimes: {},
          consecutiveFailures: 0,
          lastFailureTime: null,
          lastSwitchReason: "cc-auto-detected",
          stats: createDefaultStats(now),
          source: ccCredential.source,
        };

        manager.#accounts.push(ccAccount);
      }

      if (config.cc_credential_reuse.prefer_over_oauth && manager.getCCAccounts().length > 0) {
        manager.#accounts = [...manager.getCCAccounts(), ...manager.getOAuthAccounts()];
      }

      manager.#accounts.forEach((account, index) => {
        account.index = index;
      });

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
  addAccount(refreshToken: string, accessToken: string, expires: number, email?: string): ManagedAccount | null {
    if (this.#accounts.length >= MAX_ACCOUNTS) return null;

    const existing = this.#accounts.find((acc) => acc.refreshToken === refreshToken);
    if (existing) {
      existing.access = accessToken;
      existing.expires = expires;
      existing.tokenUpdatedAt = Date.now();
      if (email) existing.email = email;
      existing.enabled = true;
      return existing;
    }

    const now = Date.now();
    const account: ManagedAccount = {
      id: `${now}:${refreshToken.slice(0, 12)}`,
      index: this.#accounts.length,
      email,
      refreshToken,
      access: accessToken,
      expires,
      tokenUpdatedAt: now,
      addedAt: now,
      lastUsed: 0,
      enabled: true,
      rateLimitResetTimes: {},
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSwitchReason: "initial",
      stats: createDefaultStats(now),
    };

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

    this.#accounts.forEach((acc, i) => {
      acc.index = i;
    });

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

    for (let i = 0; i < this.#accounts.length; i++) {
      this.#healthTracker.reset(i);
    }
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
        if (this.#config.debug) console.error("[opencode-anthropic-auth] saveToDisk failed:", (err as Error).message);
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
    try {
      const diskData = await loadAccounts();
      if (diskData) {
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

      const byAddedAt = diskAccountsByAddedAt?.get(account.addedAt);
      if (byAddedAt?.length === 1) return byAddedAt[0]!;

      const byToken = diskAccountsByRefreshToken?.get(account.refreshToken);
      if (byToken) return byToken;

      if (byAddedAt && byAddedAt.length > 0) return byAddedAt[0]!;
      return null;
    };

    const storage: AccountStorage = {
      version: 1,
      accounts: this.#accounts.map((acc) => {
        const delta = this.#statsDeltas.get(acc.id);
        let mergedStats = acc.stats;
        const diskAcc = findDiskAccount(acc);

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
      }),
      activeIndex: Math.max(0, this.#currentIndex),
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

    const existingByTokenForSnapshot = new Map(this.#accounts.map((acc) => [acc.refreshToken, acc]));
    const memSnapshot = this.#accounts.map((acc) => `${acc.id}:${acc.refreshToken}:${acc.enabled ? 1 : 0}`).join("|");

    const diskSnapshot = stored.accounts
      .map((acc) => {
        const resolvedId = acc.id || existingByTokenForSnapshot.get(acc.refreshToken)?.id || acc.refreshToken;
        return `${resolvedId}:${acc.refreshToken}:${acc.enabled ? 1 : 0}`;
      })
      .join("|");

    if (diskSnapshot !== memSnapshot) {
      const existingById = new Map(this.#accounts.map((acc) => [acc.id, acc]));
      const existingByToken = new Map(this.#accounts.map((acc) => [acc.refreshToken, acc]));

      this.#accounts = stored.accounts.map((acc, index) => {
        const existing =
          (acc.id && existingById.get(acc.id)) || (!acc.id ? existingByToken.get(acc.refreshToken) : null);
        return {
          id: acc.id || existing?.id || `${acc.addedAt}:${acc.refreshToken.slice(0, 12)}`,
          index,
          email: acc.email ?? existing?.email,
          refreshToken: acc.refreshToken,
          access: acc.access ?? existing?.access,
          expires: acc.expires ?? existing?.expires,
          tokenUpdatedAt: acc.token_updated_at ?? existing?.tokenUpdatedAt ?? acc.addedAt,
          addedAt: acc.addedAt,
          lastUsed: acc.lastUsed,
          enabled: acc.enabled,
          rateLimitResetTimes: acc.rateLimitResetTimes,
          consecutiveFailures: acc.consecutiveFailures,
          lastFailureTime: acc.lastFailureTime,
          lastSwitchReason: acc.lastSwitchReason || existing?.lastSwitchReason || "initial",
          stats: acc.stats ?? existing?.stats ?? createDefaultStats(),
        };
      });

      this.#healthTracker = new HealthScoreTracker(this.#config.health_score);
      this.#tokenTracker = new TokenBucketTracker(this.#config.token_bucket);

      const currentIds = new Set(this.#accounts.map((a) => a.id));
      for (const id of this.#statsDeltas.keys()) {
        if (!currentIds.has(id)) this.#statsDeltas.delete(id);
      }

      if (this.#accounts.length === 0) {
        this.#currentIndex = -1;
        this.#cursor = 0;
        return;
      }
    }

    const diskIndex = Math.min(stored.activeIndex, this.#accounts.length - 1);
    if (diskIndex >= 0 && diskIndex !== this.#currentIndex) {
      const diskAccount = stored.accounts[diskIndex];
      if (!diskAccount || !diskAccount.enabled) return;

      const account = this.#accounts[diskIndex];
      if (account && account.enabled) {
        this.#currentIndex = diskIndex;
        this.#cursor = diskIndex;
        this.#healthTracker.reset(diskIndex);
      }
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
