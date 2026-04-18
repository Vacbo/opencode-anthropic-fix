import type { RateLimitReason } from "./backoff.js";
import { calculateBackoffMs } from "./backoff.js";
import { readCCCredentials } from "./cc-credentials.js";
import { resolveIdentityFromCCCredential, type AccountIdentity } from "./account-identity.js";
import {
    createBootstrapAccountFromFallback,
    loadManagedAccountsFromStorage,
    mergeAuthFallbackIntoAccounts,
    prepareStorageForSave,
    reconcileManagedAccountsWithStorage,
} from "./accounts/persistence.js";
import {
    createManagedAccount,
    findMatchingManagedAccount,
    reindexManagedAccounts,
    resolveManagedAccountIdentity,
} from "./accounts/matching.js";
import { inferCCSourceFromId, repairCorruptedCCAccounts } from "./accounts/repair.js";
import type { AnthropicAuthConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { HealthScoreTracker, selectAccount, TokenBucketTracker } from "./rotation.js";
import type { AccountStats, AccountStorage } from "./storage.js";
import { createDefaultStats, loadAccounts, saveAccounts } from "./storage.js";

const accountsLogger = createLogger("accounts");

export interface ManagedAccount {
    id: string;
    accountUuid?: string;
    organizationUuid?: string;
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

type AddAccountOptions = {
    identity?: AccountIdentity;
    label?: string;
    source?: ManagedAccount["source"];
};

export class AccountManager {
    #accounts: ManagedAccount[] = [];
    #cursor = 0;
    #currentIndex = -1;
    #healthTracker: HealthScoreTracker;
    #tokenTracker: TokenBucketTracker;
    #config: AnthropicAuthConfig;
    #saveTimeout: ReturnType<typeof setTimeout> | null = null;
    #statsDeltas = new Map<string, StatsDelta>();
    #pendingDroppedIds = new Set<string>();
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
            const loaded = loadManagedAccountsFromStorage(stored);
            manager.#accounts = loaded.accounts;
            manager.#currentIndex = loaded.currentIndex;

            if (authFallback && manager.#accounts.length > 0) {
                mergeAuthFallbackIntoAccounts(manager.#accounts, authFallback, manager.#currentIndex);
            }

            // No stored accounts — bootstrap from fallback if available
        } else if (authFallback && authFallback.refresh) {
            manager.#accounts = [createBootstrapAccountFromFallback(authFallback)];
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

            // Heal corrupted CC rows that lost source/identity/label in an older
            // write path, and collapse any resulting duplicates BEFORE auto-import
            // runs. Otherwise auto-import would fail to match the corrupted row
            // and create a fresh duplicate every load. Dropped ids are stashed on
            // the manager so the next saveToDisk can tell prepareStorageForSave
            // not to restore them via the disk-only union.
            const repair = repairCorruptedCCAccounts(manager.#accounts, ccCredentials);
            if (repair.result.collapsed > 0 || repair.result.repaired > 0) {
                const beforeIds = new Set(manager.#accounts.map((account) => account.id));
                manager.#accounts = repair.accounts;
                reindexManagedAccounts(manager.#accounts);
                const afterIds = new Set(manager.#accounts.map((account) => account.id));
                for (const id of beforeIds) {
                    if (!afterIds.has(id)) manager.#pendingDroppedIds.add(id);
                }
                if (manager.#currentIndex >= manager.#accounts.length) {
                    manager.#currentIndex = manager.#accounts.length > 0 ? 0 : -1;
                }
            }

            for (const ccCredential of ccCredentials) {
                const ccIdentity = resolveIdentityFromCCCredential(ccCredential);
                let existingMatch = findMatchingManagedAccount(manager.#accounts, {
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
                    existingMatch.identity = ccIdentity;
                    existingMatch.source = ccCredential.source;
                    existingMatch.label = ccCredential.label;
                    existingMatch.enabled = true;

                    const localAuthRecency = Math.max(existingMatch.tokenUpdatedAt || 0, existingMatch.expires || 0);
                    const ccAuthRecency = ccCredential.expiresAt || 0;
                    const shouldAdoptCcAuth =
                        !existingMatch.access ||
                        !existingMatch.expires ||
                        ccAuthRecency >= localAuthRecency ||
                        existingMatch.refreshToken === ccCredential.refreshToken;

                    if (shouldAdoptCcAuth) {
                        existingMatch.refreshToken = ccCredential.refreshToken;
                        existingMatch.access = ccCredential.accessToken;
                        existingMatch.expires = ccCredential.expiresAt;
                        existingMatch.tokenUpdatedAt = Math.max(
                            existingMatch.tokenUpdatedAt || 0,
                            ccCredential.expiresAt || 0,
                        );
                    }
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

            reindexManagedAccounts(manager.#accounts);

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
     * Get live managed-account references for CLI/admin flows that may mutate
     * token state and then persist it back to disk.
     */
    getManagedAccounts(): ManagedAccount[] {
        return this.#accounts;
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

        if (
            account.lastFailureTime !== null &&
            now - account.lastFailureTime > this.#config.failure_ttl_seconds * 1000
        ) {
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
        const identity = resolveManagedAccountIdentity({
            refreshToken,
            email,
            identity: options?.identity,
            label: options?.label,
            source: options?.source ?? "oauth",
        });
        const existing = findMatchingManagedAccount(this.#accounts, {
            identity,
            refreshToken,
        });

        if (existing) {
            // Refuse to downgrade a CC-sourced row to oauth/legacy. The id prefix
            // `cc-cc-(keychain|file)-` proves the row was born as a CC import; a
            // caller without explicit CC options must only refresh tokens, never
            // reshape source/identity/label/email.
            const isExistingCC = existing.source === "cc-keychain" || existing.source === "cc-file";
            const isNewCC = options?.source === "cc-keychain" || options?.source === "cc-file";
            const isCCBornId = inferCCSourceFromId(existing.id) !== null;
            const callerWouldDowngrade = (isExistingCC || isCCBornId) && !isNewCC;

            existing.refreshToken = refreshToken;
            existing.access = accessToken;
            existing.expires = expires;
            existing.tokenUpdatedAt = Date.now();
            existing.enabled = true;

            if (!callerWouldDowngrade) {
                existing.email = email ?? existing.email;
                existing.identity = identity;
                existing.label = options?.label ?? existing.label;
                existing.source = options?.source ?? existing.source ?? "oauth";
            }

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

        reindexManagedAccounts(this.#accounts);

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
        let diskData: AccountStorage | null = null;
        try {
            diskData = await loadAccounts();
        } catch (error) {
            accountsLogger.debug("saveToDisk read-from-disk failed; writing absolute values", { error });
        }

        const droppedIdsSnapshot = new Set(this.#pendingDroppedIds);
        const prepared = prepareStorageForSave({
            accounts: this.#accounts,
            currentIndex: this.#currentIndex,
            statsDeltas: this.#statsDeltas,
            diskData,
            droppedIds: droppedIdsSnapshot,
        });

        await saveAccounts(prepared.storage, { droppedIds: droppedIdsSnapshot });

        this.#statsDeltas.clear();
        this.#pendingDroppedIds.clear();

        for (const [id, persistedState] of prepared.persistedStateById.entries()) {
            const account = this.#accounts.find((candidate) => candidate.id === id);
            if (account) {
                account.stats = persistedState.stats;
            }
        }
    }

    /**
     * Sync activeIndex from disk (picks up CLI changes while OpenCode is running).
     */
    async syncActiveIndexFromDisk(): Promise<void> {
        const stored = await loadAccounts();
        if (!stored) return;

        const reconciled = reconcileManagedAccountsWithStorage({
            accounts: this.#accounts,
            stored,
            currentIndex: this.#currentIndex,
            statsDeltaIds: this.#statsDeltas.keys(),
        });

        this.#accounts = reconciled.accounts;
        reindexManagedAccounts(this.#accounts);

        if (reconciled.shouldRebuildTrackers) {
            this.#rebuildTrackers();
        }

        for (const id of reconciled.staleDeltaIds) {
            this.#statsDeltas.delete(id);
        }

        this.#currentIndex = reconciled.currentIndex;
        this.#cursor = reconciled.cursor;

        if (reconciled.resetHealthTrackerIndex !== null) {
            this.#healthTracker.reset(reconciled.resetHealthTrackerIndex);
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
                        console.error(
                            "[opencode-anthropic-auth] forced statsDeltas flush failed:",
                            (err as Error).message,
                        );
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
