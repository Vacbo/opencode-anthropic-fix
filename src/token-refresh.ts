// ---------------------------------------------------------------------------
// Token refresh (per-account)
// ---------------------------------------------------------------------------

import type { ManagedAccount } from "./accounts.js";
import type { RateLimitReason } from "./backoff.js";
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
  const diskHasDifferentAuth = diskAuth.refreshToken !== account.refreshToken || diskAuth.access !== account.access;
  const memAuthExpired = !account.expires || account.expires <= Date.now();
  const allowExpiredFallback = options.allowExpiredFallback === true;
  if (diskTokenUpdatedAt <= memTokenUpdatedAt && !(allowExpiredFallback && diskHasDifferentAuth && memAuthExpired)) {
    return false;
  }
  account.refreshToken = diskAuth.refreshToken;
  account.access = diskAuth.access;
  account.expires = diskAuth.expires;
  account.tokenUpdatedAt = Math.max(memTokenUpdatedAt, diskTokenUpdatedAt);
  return true;
}

export interface RefreshAccountTokenOptions {
  onTokensUpdated?: () => Promise<void>;
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
  { onTokensUpdated }: RefreshAccountTokenOptions = {},
): Promise<string> {
  const lockResult = await acquireRefreshLock(account.id, {
    timeoutMs: 2_000,
    backoffMs: 60,
    staleMs: 20_000,
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
    if (adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
    }
    throw new Error("Refresh lock busy");
  }

  try {
    const diskAuthBeforeRefresh = await readDiskAccountAuth(account.id);
    const adopted = applyDiskAuthIfFresher(account, diskAuthBeforeRefresh);
    if (source === "foreground" && adopted && account.access && account.expires && account.expires > Date.now()) {
      return account.access;
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
