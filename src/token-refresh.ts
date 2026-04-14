// ---------------------------------------------------------------------------
// Token refresh (per-account)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import type { ManagedAccount } from "./accounts.js";
import type { RateLimitReason } from "./backoff.js";
import type { CCCredential } from "./cc-credentials.js";
import { readCCCredentials, readCCCredentialsFromFile } from "./cc-credentials.js";
import { FOREGROUND_EXPIRY_BUFFER_MS } from "./constants.js";
import { refreshToken } from "./oauth.js";
import { acquireRefreshLock, releaseRefreshLock } from "./refresh-lock.js";
import { loadAccounts } from "./storage.js";

export type { ManagedAccount };

export interface DiskAuth {
    refreshToken: string;
    access?: string;
    expires?: number;
    tokenUpdatedAt: number;
}

/**
 * Read the latest auth fields for an account from disk.
 * Another instance may have rotated tokens since we loaded into memory.
 */
export async function readDiskAccountAuth(accountId: string): Promise<DiskAuth | null> {
    try {
        const diskData = await loadAccounts();
        if (!diskData) return null;
        const diskAccount = diskData.accounts.find((a) => a.id === accountId);
        if (!diskAccount) return null;
        return {
            refreshToken: diskAccount.refreshToken,
            access: diskAccount.access,
            expires: diskAccount.expires,
            tokenUpdatedAt: diskAccount.token_updated_at,
        };
    } catch {
        return null;
    }
}

/**
 * Stamp the account's tokenUpdatedAt to the current time.
 */
export function markTokenStateUpdated(account: ManagedAccount, now = Date.now()): void {
    account.tokenUpdatedAt = now;
}

/**
 * Adopt disk auth fields only when disk has fresher token state.
 * Returns true if the account was updated from disk.
 */
export function applyDiskAuthIfFresher(
    account: ManagedAccount,
    diskAuth: DiskAuth | null,
    options: { allowExpiredFallback?: boolean } = {},
): boolean {
    if (!diskAuth) return false;
    const diskTokenUpdatedAt = diskAuth.tokenUpdatedAt || 0;
    const memTokenUpdatedAt = account.tokenUpdatedAt || 0;
    const diskIsNewer = diskTokenUpdatedAt > memTokenUpdatedAt;
    const diskHasDifferentRefreshToken = diskAuth.refreshToken !== account.refreshToken;
    const memAuthExpired = !account.expires || account.expires <= Date.now();
    const allowExpiredFallback = options.allowExpiredFallback === true;
    if (!diskIsNewer && !(allowExpiredFallback && diskHasDifferentRefreshToken && memAuthExpired)) {
        return false;
    }
    account.refreshToken = diskAuth.refreshToken;
    account.access = diskAuth.access;
    account.expires = diskAuth.expires;
    if (diskIsNewer) {
        account.tokenUpdatedAt = diskTokenUpdatedAt;
    }
    return true;
}

export interface RefreshAccountTokenOptions {
    onTokensUpdated?: () => Promise<void>;
    debugLog?: (...args: unknown[]) => void;
}

export interface OpenCodeClient {
    auth?: {
        set(params: {
            path: { id: string };
            body: {
                type: string;
                refresh: string;
                access?: string;
                expires?: number;
            };
        }): Promise<unknown>;
    };
    session?: {
        prompt(params: {
            path: { id: string };
            body: {
                noReply: boolean;
                parts: Array<{ type: "text"; text: string; ignored?: boolean }>;
            };
        }): Promise<unknown>;
    };
    tui?: {
        showToast(params: {
            body: {
                message: string;
                variant: "info" | "success" | "warning" | "error";
            };
        }): Promise<unknown>;
    };
}

function claudeBinaryPath(): string | null {
    try {
        return execSync("which claude", {
            encoding: "utf-8",
            timeout: 5000,
        }).trim();
    } catch {
        return null;
    }
}

function isFreshCCCredential(credential: CCCredential | null): boolean {
    return Boolean(credential && credential.expiresAt > Date.now() + FOREGROUND_EXPIRY_BUFFER_MS);
}

function selectCCCredential(
    account: ManagedAccount,
    credentials: CCCredential[],
    preferredLabel?: string,
): CCCredential | null {
    if (credentials.length === 0) return null;
    if (preferredLabel) {
        const byLabel = credentials.find((credential) => credential.label === preferredLabel);
        if (byLabel) return byLabel;
    }

    const byRefreshToken = credentials.find((credential) => credential.refreshToken === account.refreshToken);
    if (byRefreshToken) return byRefreshToken;

    if (account.access) {
        const byAccessToken = credentials.find((credential) => credential.accessToken === account.access);
        if (byAccessToken) return byAccessToken;
    }

    return credentials.length === 1 ? credentials[0] : null;
}

function readCredentialForAccount(account: ManagedAccount, preferredLabel?: string): CCCredential | null {
    if (account.source === "cc-file") {
        return readCCCredentialsFromFile();
    }

    if (account.source !== "cc-keychain") {
        return null;
    }

    const keychainCredentials = readCCCredentials().filter((credential) => credential.source === "cc-keychain");
    return selectCCCredential(account, keychainCredentials, preferredLabel);
}

async function refreshCCAccount(account: ManagedAccount): Promise<string | null> {
    const initialCredential = readCredentialForAccount(account);
    if (!initialCredential) return null;

    if (isFreshCCCredential(initialCredential)) {
        account.access = initialCredential.accessToken;
        account.refreshToken = initialCredential.refreshToken;
        account.expires = initialCredential.expiresAt;
        markTokenStateUpdated(account);
        return initialCredential.accessToken;
    }

    const claudePath = claudeBinaryPath();
    if (!claudePath) return null;

    try {
        execSync(`${claudePath} -p . --model haiku`, {
            encoding: "utf-8",
            timeout: 60000,
        });
    } catch {
        return null;
    }

    const refreshedCredential = readCredentialForAccount(account, initialCredential.label);
    if (!isFreshCCCredential(refreshedCredential)) return null;
    if (!refreshedCredential) return null;

    account.access = refreshedCredential.accessToken;
    account.refreshToken = refreshedCredential.refreshToken;
    account.expires = refreshedCredential.expiresAt;
    markTokenStateUpdated(account);
    return refreshedCredential.accessToken;
}

/**
 * Refresh an account's access token.
 *
 * @param account - The account to refresh
 * @param client - OpenCode client for persisting to auth.json
 * @param source - "foreground" | "idle"
 * @param options - Optional onTokensUpdated callback called under the lock after token update
 * @returns The new access token
 * @throws If refresh fails
 */
export async function refreshAccountToken(
    account: ManagedAccount,
    client: OpenCodeClient,
    source: "foreground" | "idle" = "foreground",
    { onTokensUpdated, debugLog }: RefreshAccountTokenOptions = {},
): Promise<string> {
    const lockResult = await acquireRefreshLock(account.id, {
        backoffMs: 60,
    });
    const lock =
        lockResult && typeof lockResult === "object"
            ? lockResult
            : {
                  acquired: true,
                  lockPath: null,
                  owner: null,
                  lockInode: null,
              };

    if (!lock.acquired) {
        const diskAuth = await readDiskAccountAuth(account.id);
        const adopted = applyDiskAuthIfFresher(account, diskAuth, {
            allowExpiredFallback: true,
        });
        if (
            adopted &&
            account.access &&
            account.expires &&
            account.expires > Date.now() + FOREGROUND_EXPIRY_BUFFER_MS
        ) {
            return account.access;
        }
        throw new Error("Refresh lock busy");
    }

    try {
        const diskAuthBeforeRefresh = await readDiskAccountAuth(account.id);
        const adopted = applyDiskAuthIfFresher(account, diskAuthBeforeRefresh);
        if (
            source === "foreground" &&
            adopted &&
            account.access &&
            account.expires &&
            account.expires > Date.now() + FOREGROUND_EXPIRY_BUFFER_MS
        ) {
            return account.access;
        }

        if (account.source === "cc-keychain" || account.source === "cc-file") {
            const accessToken = await refreshCCAccount(account);
            if (accessToken) {
                if (onTokensUpdated) {
                    await onTokensUpdated().catch((err) => {
                        debugLog?.("onTokensUpdated failed:", (err as Error).message);
                    });
                }

                await client.auth
                    ?.set({
                        path: { id: "anthropic" },
                        body: {
                            type: "oauth",
                            refresh: account.refreshToken,
                            access: account.access,
                            expires: account.expires,
                        },
                    })
                    .catch((err) => {
                        debugLog?.("auth.set failed:", (err as Error).message);
                    });
                return accessToken;
            }
            throw new Error("CC credential refresh failed");
        }

        const json = await refreshToken(account.refreshToken, {
            signal: AbortSignal.timeout(10_000),
        });

        account.access = json.access_token;
        account.expires = Date.now() + json.expires_in * 1000;
        if (json.refresh_token) {
            account.refreshToken = json.refresh_token;
        }
        markTokenStateUpdated(account);

        // Persist new tokens to disk BEFORE releasing the cross-process lock.
        // This is critical: if we release the lock first, another process can
        // acquire it and read the old (now-rotated) refresh token from disk,
        // leading to an invalid_grant failure.
        if (onTokensUpdated) {
            try {
                await onTokensUpdated();
            } catch {
                // Best-effort: in-memory tokens remain valid for this process.
            }
        }

        // Also persist to OpenCode's auth.json for compatibility.
        try {
            await client.auth?.set({
                path: { id: "anthropic" },
                body: {
                    type: "oauth",
                    refresh: account.refreshToken,
                    access: account.access,
                    expires: account.expires,
                },
            });
        } catch {
            // Ignore persistence errors; in-memory tokens remain valid for this request.
        }

        return json.access_token;
    } finally {
        await releaseRefreshLock(lock);
    }
}

/**
 * Build user-facing switch reason text for account-specific errors.
 */
export function formatSwitchReason(status: number, reason: RateLimitReason): string {
    if (reason === "AUTH_FAILED") return "auth failed";
    if (status === 403 && reason === "QUOTA_EXHAUSTED") return "permission denied";
    if (reason === "QUOTA_EXHAUSTED") return "quota exhausted";
    return "rate-limited";
}
