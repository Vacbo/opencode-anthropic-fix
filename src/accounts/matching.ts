import { findByIdentity, type AccountIdentity } from "../account-identity.js";
import { createDefaultStats, type AccountMetadata, type AccountStats } from "../storage.js";
import type { ManagedAccount } from "../accounts.js";

type ManagedAccountSource = ManagedAccount["source"];

type ManagedAccountInit = {
    id?: string;
    accountUuid?: string;
    organizationUuid?: string;
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

export function resolveManagedAccountIdentity(params: {
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

export function createManagedAccount(init: ManagedAccountInit): ManagedAccount {
    const now = init.now ?? Date.now();
    const addedAt = init.addedAt ?? now;
    const tokenUpdatedAt = init.tokenUpdatedAt ?? addedAt;
    const identity = resolveManagedAccountIdentity({
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
        accountUuid: init.accountUuid,
        organizationUuid: init.organizationUuid,
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

export function findMatchingManagedAccount(
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

export function reindexManagedAccounts(accounts: ManagedAccount[]): void {
    accounts.forEach((account, index) => {
        account.index = index;
    });
}

export function updateManagedAccountFromStorage(
    existing: ManagedAccount,
    account: AccountMetadata,
    index: number,
): void {
    // Prefer existing source when it is CC and disk source is not — protects a
    // healthy in-memory CC row from being downgraded by a malformed disk row
    // during syncActiveIndexFromDisk.
    const isExistingCC = existing.source === "cc-keychain" || existing.source === "cc-file";
    const isDiskCC = account.source === "cc-keychain" || account.source === "cc-file";
    const source = isExistingCC && !isDiskCC ? existing.source : account.source || existing.source || "oauth";
    const label = account.label ?? existing.label;
    const email = account.email ?? existing.email;

    existing.id = account.id || existing.id || `${account.addedAt}:${account.refreshToken.slice(0, 12)}`;
    existing.accountUuid = account.accountUuid ?? existing.accountUuid;
    existing.organizationUuid = account.organizationUuid ?? existing.organizationUuid;
    existing.index = index;
    existing.email = email;
    existing.label = label;
    existing.identity = resolveManagedAccountIdentity({
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
