import { findByIdentity, resolveIdentity } from "../account-identity.js";
import type { ManagedAccount, StatsDelta } from "../accounts.js";
import type { AccountMetadata, AccountStats, AccountStorage } from "../storage.js";
import {
    createManagedAccount,
    findMatchingManagedAccount,
    resolveManagedAccountIdentity,
    updateManagedAccountFromStorage,
} from "./matching.js";

export type AuthFallback = {
    refresh: string;
    access?: string;
    expires?: number;
};

type DiskLookup = {
    accounts: AccountMetadata[];
    byId: Map<string, AccountMetadata>;
    byAddedAt: Map<number, AccountMetadata[]>;
    byRefreshToken: Map<string, AccountMetadata>;
};

type PersistedAccountState = {
    refreshToken: string;
    access?: string;
    expires?: number;
    tokenUpdatedAt: number;
    stats: AccountStats;
};

export type PreparedStorageSave = {
    storage: AccountStorage;
    persistedStateById: Map<string, PersistedAccountState>;
    droppedIds: ReadonlySet<string>;
};

export type ReconciledAccounts = {
    accounts: ManagedAccount[];
    currentIndex: number;
    cursor: number;
    shouldRebuildTrackers: boolean;
    resetHealthTrackerIndex: number | null;
    staleDeltaIds: string[];
};

export function loadManagedAccountsFromStorage(stored: AccountStorage): {
    accounts: ManagedAccount[];
    currentIndex: number;
} {
    const accounts = stored.accounts.map((account, index) =>
        createManagedAccount({
            id: account.id || `${account.addedAt}:${account.refreshToken.slice(0, 12)}`,
            index,
            accountUuid: account.accountUuid,
            organizationUuid: account.organizationUuid,
            email: account.email,
            identity: account.identity,
            label: account.label,
            refreshToken: account.refreshToken,
            access: account.access,
            expires: account.expires,
            tokenUpdatedAt: account.token_updated_at,
            addedAt: account.addedAt,
            lastUsed: account.lastUsed,
            enabled: account.enabled,
            rateLimitResetTimes: account.rateLimitResetTimes,
            consecutiveFailures: account.consecutiveFailures,
            lastFailureTime: account.lastFailureTime,
            lastSwitchReason: account.lastSwitchReason,
            stats: account.stats,
            source: account.source || "oauth",
        }),
    );

    return {
        accounts,
        currentIndex: accounts.length > 0 ? Math.min(stored.activeIndex, accounts.length - 1) : -1,
    };
}

export function mergeAuthFallbackIntoAccounts(
    accounts: ManagedAccount[],
    authFallback: AuthFallback,
    preferredIndex = -1,
): void {
    if (accounts.length === 0) {
        return;
    }

    const fallbackIdentity = resolveManagedAccountIdentity({
        refreshToken: authFallback.refresh,
        source: "oauth",
    });
    let match = findMatchingManagedAccount(accounts, {
        identity: fallbackIdentity,
        refreshToken: authFallback.refresh,
    });

    const fallbackHasAccess = typeof authFallback.access === "string" && authFallback.access.length > 0;
    const fallbackExpires = typeof authFallback.expires === "number" ? authFallback.expires : 0;
    const fallbackLooksFresh = fallbackHasAccess && fallbackExpires > Date.now();

    if (!match && fallbackLooksFresh) {
        const preferredAccount =
            preferredIndex >= 0 && preferredIndex < accounts.length ? accounts[preferredIndex] : accounts.length === 1 ? accounts[0] : null;
        match = preferredAccount ?? null;
    }

    if (!match) {
        return;
    }

    const matchExpires = typeof match.expires === "number" ? match.expires : 0;
    const shouldAdoptFallback =
        fallbackLooksFresh && (!match.access || !match.expires || fallbackExpires > matchExpires || match.refreshToken !== authFallback.refresh);

    if (!shouldAdoptFallback) {
        return;
    }

    match.refreshToken = authFallback.refresh;
    match.access = authFallback.access;
    match.expires = authFallback.expires;
    match.tokenUpdatedAt = Math.max(match.tokenUpdatedAt || 0, fallbackExpires);
}

export function createBootstrapAccountFromFallback(authFallback: AuthFallback, now = Date.now()): ManagedAccount {
    return createManagedAccount({
        id: `${now}:${authFallback.refresh.slice(0, 12)}`,
        index: 0,
        refreshToken: authFallback.refresh,
        access: authFallback.access,
        expires: authFallback.expires,
        tokenUpdatedAt: now,
        addedAt: now,
        lastSwitchReason: "initial",
        source: "oauth",
    });
}

function createDiskLookup(diskData: AccountStorage | null): DiskLookup {
    const accounts = diskData?.accounts ?? [];
    const byAddedAt = new Map<number, AccountMetadata[]>();

    for (const account of accounts) {
        const bucket = byAddedAt.get(account.addedAt) ?? [];
        bucket.push(account);
        byAddedAt.set(account.addedAt, bucket);
    }

    return {
        accounts,
        byId: new Map(accounts.map((account) => [account.id, account])),
        byAddedAt,
        byRefreshToken: new Map(accounts.map((account) => [account.refreshToken, account])),
    };
}

function findMatchingDiskAccount(account: ManagedAccount, diskLookup: DiskLookup): AccountMetadata | null {
    const byId = diskLookup.byId.get(account.id);
    if (byId) return byId;

    const byIdentity = findByIdentity(diskLookup.accounts, resolveIdentity(account));
    if (byIdentity) return byIdentity;

    const byAddedAt = diskLookup.byAddedAt.get(account.addedAt);
    if (byAddedAt?.length === 1) return byAddedAt[0]!;

    const byRefreshToken = diskLookup.byRefreshToken.get(account.refreshToken);
    if (byRefreshToken) return byRefreshToken;

    return byAddedAt?.[0] ?? null;
}

function mergePersistedStats(
    account: ManagedAccount,
    diskAccount: AccountMetadata | null,
    delta: StatsDelta | undefined,
): AccountStats {
    if (!delta) {
        return account.stats;
    }

    if (delta.isReset) {
        return {
            requests: delta.requests,
            inputTokens: delta.inputTokens,
            outputTokens: delta.outputTokens,
            cacheReadTokens: delta.cacheReadTokens,
            cacheWriteTokens: delta.cacheWriteTokens,
            lastReset: delta.resetTimestamp ?? account.stats.lastReset,
        };
    }

    if (!diskAccount?.stats) {
        return account.stats;
    }

    return {
        requests: diskAccount.stats.requests + delta.requests,
        inputTokens: diskAccount.stats.inputTokens + delta.inputTokens,
        outputTokens: diskAccount.stats.outputTokens + delta.outputTokens,
        cacheReadTokens: diskAccount.stats.cacheReadTokens + delta.cacheReadTokens,
        cacheWriteTokens: diskAccount.stats.cacheWriteTokens + delta.cacheWriteTokens,
        lastReset: diskAccount.stats.lastReset,
    };
}

function applyFreshestAuth(account: ManagedAccount, diskAccount: AccountMetadata | null): PersistedAccountState {
    const memoryTokenUpdatedAt = account.tokenUpdatedAt || 0;
    const diskTokenUpdatedAt = diskAccount?.token_updated_at || 0;
    const freshestAuth =
        diskAccount && diskTokenUpdatedAt > memoryTokenUpdatedAt
            ? {
                  refreshToken: diskAccount.refreshToken,
                  access: diskAccount.access,
                  expires: diskAccount.expires,
                  tokenUpdatedAt: diskTokenUpdatedAt,
              }
            : {
                  refreshToken: account.refreshToken,
                  access: account.access,
                  expires: account.expires,
                  tokenUpdatedAt: memoryTokenUpdatedAt,
              };

    account.refreshToken = freshestAuth.refreshToken;
    account.access = freshestAuth.access;
    account.expires = freshestAuth.expires;
    account.tokenUpdatedAt = freshestAuth.tokenUpdatedAt;

    return {
        ...freshestAuth,
        stats: account.stats,
    };
}

export function prepareStorageForSave(params: {
    accounts: ManagedAccount[];
    currentIndex: number;
    statsDeltas: Map<string, StatsDelta>;
    diskData: AccountStorage | null;
    droppedIds?: ReadonlySet<string>;
}): PreparedStorageSave {
    const diskLookup = createDiskLookup(params.diskData);
    const matchedDiskAccounts = new Set<AccountMetadata>();
    const activeAccountId = params.accounts[params.currentIndex]?.id ?? null;
    const persistedStateById = new Map<string, PersistedAccountState>();
    const accountsToPersist = params.accounts.filter(
        (account) => account.enabled || !!findMatchingDiskAccount(account, diskLookup),
    );

    const persistedAccounts = accountsToPersist.map((account) => {
        const delta = params.statsDeltas.get(account.id);
        const diskAccount = findMatchingDiskAccount(account, diskLookup);

        if (diskAccount) {
            matchedDiskAccounts.add(diskAccount);
        }

        const mergedStats = mergePersistedStats(account, diskAccount, delta);
        account.stats = mergedStats;
        const freshestAuth = applyFreshestAuth(account, diskAccount);
        freshestAuth.stats = mergedStats;
        persistedStateById.set(account.id, freshestAuth);

        return {
            id: account.id,
            accountUuid: account.accountUuid,
            organizationUuid: account.organizationUuid,
            email: account.email,
            identity: account.identity,
            label: account.label,
            refreshToken: freshestAuth.refreshToken,
            access: freshestAuth.access,
            expires: freshestAuth.expires,
            token_updated_at: freshestAuth.tokenUpdatedAt,
            addedAt: account.addedAt,
            lastUsed: account.lastUsed,
            enabled: account.enabled,
            rateLimitResetTimes: Object.keys(account.rateLimitResetTimes).length > 0 ? account.rateLimitResetTimes : {},
            consecutiveFailures: account.consecutiveFailures,
            lastFailureTime: account.lastFailureTime,
            lastSwitchReason: account.lastSwitchReason,
            stats: mergedStats,
            source: account.source,
        } satisfies AccountMetadata;
    });

    const droppedIds = params.droppedIds;
    const diskOnlyAccounts = diskLookup.accounts.filter(
        (account) => !matchedDiskAccounts.has(account) && !(droppedIds && droppedIds.has(account.id)),
    );
    const allAccounts = accountsToPersist.length > 0 ? [...persistedAccounts, ...diskOnlyAccounts] : persistedAccounts;
    const resolvedActiveIndex = activeAccountId
        ? allAccounts.findIndex((account) => account.id === activeAccountId)
        : -1;

    return {
        storage: {
            version: 1,
            accounts: allAccounts,
            activeIndex:
                resolvedActiveIndex >= 0
                    ? resolvedActiveIndex
                    : allAccounts.length > 0
                      ? Math.max(0, Math.min(params.currentIndex, allAccounts.length - 1))
                      : 0,
        },
        persistedStateById,
        droppedIds: droppedIds ?? new Set<string>(),
    };
}

export function reconcileManagedAccountsWithStorage(params: {
    accounts: ManagedAccount[];
    stored: AccountStorage;
    currentIndex: number;
    statsDeltaIds: Iterable<string>;
}): ReconciledAccounts {
    const matchedAccounts = new Set<ManagedAccount>();
    const reconciledAccounts: ManagedAccount[] = [];
    let structuralChange = false;

    for (const [index, storedAccount] of params.stored.accounts.entries()) {
        const existing = findMatchingManagedAccount(params.accounts, {
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
            accountUuid: storedAccount.accountUuid,
            organizationUuid: storedAccount.organizationUuid,
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

    for (const account of params.accounts) {
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
        reconciledAccounts.length !== params.accounts.length ||
        reconciledAccounts.some((account, index) => params.accounts[index] !== account);

    const currentIds = new Set(reconciledAccounts.map((account) => account.id));
    const staleDeltaIds = Array.from(params.statsDeltaIds).filter((id) => !currentIds.has(id));
    const enabledAccounts = reconciledAccounts.filter((account) => account.enabled);

    if (enabledAccounts.length === 0) {
        return {
            accounts: reconciledAccounts,
            currentIndex: -1,
            cursor: 0,
            shouldRebuildTrackers: orderChanged || structuralChange,
            resetHealthTrackerIndex: null,
            staleDeltaIds,
        };
    }

    const diskIndex = Math.min(params.stored.activeIndex, params.stored.accounts.length - 1);
    const diskAccount = diskIndex >= 0 ? params.stored.accounts[diskIndex] : undefined;

    if (!diskAccount || !diskAccount.enabled) {
        if (!reconciledAccounts[params.currentIndex]?.enabled) {
            const fallback = enabledAccounts[0]!;
            return {
                accounts: reconciledAccounts,
                currentIndex: fallback.index,
                cursor: fallback.index,
                shouldRebuildTrackers: orderChanged || structuralChange,
                resetHealthTrackerIndex: null,
                staleDeltaIds,
            };
        }

        return {
            accounts: reconciledAccounts,
            currentIndex: params.currentIndex,
            cursor: params.currentIndex >= 0 ? params.currentIndex : enabledAccounts[0]!.index,
            shouldRebuildTrackers: orderChanged || structuralChange,
            resetHealthTrackerIndex: null,
            staleDeltaIds,
        };
    }

    const activeAccount = findMatchingManagedAccount(reconciledAccounts, {
        id: diskAccount.id,
        identity: resolveIdentity(diskAccount),
        refreshToken: diskAccount.refreshToken,
    });

    if (activeAccount && activeAccount.enabled && activeAccount.index !== params.currentIndex) {
        return {
            accounts: reconciledAccounts,
            currentIndex: activeAccount.index,
            cursor: activeAccount.index,
            shouldRebuildTrackers: orderChanged || structuralChange,
            resetHealthTrackerIndex: activeAccount.index,
            staleDeltaIds,
        };
    }

    return {
        accounts: reconciledAccounts,
        currentIndex: params.currentIndex,
        cursor: params.currentIndex >= 0 ? params.currentIndex : enabledAccounts[0]!.index,
        shouldRebuildTrackers: orderChanged || structuralChange,
        resetHealthTrackerIndex: null,
        staleDeltaIds,
    };
}
