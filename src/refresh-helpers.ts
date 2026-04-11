import type { AccountManager, ManagedAccount } from "./accounts.js";
import type { AnthropicAuthConfig } from "./config.js";
import type { OpenCodeClient } from "./token-refresh.js";
import { markTokenStateUpdated, readDiskAccountAuth, refreshAccountToken } from "./token-refresh.js";

type RefreshSource = "foreground" | "idle";

type RefreshInFlightEntry = {
  promise: Promise<string>;
  source: RefreshSource;
};

export interface RefreshDeps {
  client: OpenCodeClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugin config accepts forward-compatible arbitrary keys
  config: AnthropicAuthConfig & Record<string, any>;
  getAccountManager: () => AccountManager | null;
  debugLog: (...args: unknown[]) => void;
}

export function createRefreshHelpers({ client, config, getAccountManager, debugLog }: RefreshDeps) {
  const refreshInFlight = new Map<string, RefreshInFlightEntry>();
  const idleRefreshLastAttempt = new Map<string, number>();
  const idleRefreshInFlight = new Set<string>();

  const IDLE_REFRESH_ENABLED = config.idle_refresh.enabled;
  const IDLE_REFRESH_WINDOW_MS = config.idle_refresh.window_minutes * 60 * 1000;
  const IDLE_REFRESH_MIN_INTERVAL_MS = config.idle_refresh.min_interval_minutes * 60 * 1000;

  function parseRefreshFailure(refreshError: unknown) {
    const message = refreshError instanceof Error ? refreshError.message : String(refreshError);
    const status =
      typeof refreshError === "object" && refreshError && "status" in refreshError
        ? Number((refreshError as Record<string, unknown>).status)
        : NaN;
    const errorCode =
      typeof refreshError === "object" && refreshError && ("errorCode" in refreshError || "code" in refreshError)
        ? String(
            (refreshError as Record<string, unknown>).errorCode || (refreshError as Record<string, unknown>).code || "",
          )
        : "";
    const msgLower = message.toLowerCase();
    const isInvalidGrant =
      errorCode === "invalid_grant" || errorCode === "invalid_request" || msgLower.includes("invalid_grant");
    const isTerminalStatus = status === 400 || status === 401 || status === 403;
    return { message, status, errorCode, isInvalidGrant, isTerminalStatus };
  }

  async function refreshAccountTokenSingleFlight(
    account: ManagedAccount,
    source: RefreshSource = "foreground",
  ): Promise<string> {
    const key = account.id;
    const existing = refreshInFlight.get(key);
    if (existing) {
      if (source === "foreground" && existing.source === "idle") {
        try {
          await existing.promise;
        } catch (err) {
          void err;
        }
        if (account.access && account.expires && account.expires > Date.now()) return account.access;
        const retried = refreshInFlight.get(key);
        if (retried && retried !== existing) {
          return retried.promise;
        }
      } else {
        return existing.promise;
      }
    }

    const entry: RefreshInFlightEntry = {
      source,
      promise: Promise.resolve(""),
    };
    const p = (async () => {
      try {
        return await refreshAccountToken(account, client, source, {
          onTokensUpdated: async () => {
            try {
              await getAccountManager()!.saveToDisk();
            } catch {
              getAccountManager()!.requestSaveToDisk();
              throw new Error("save failed, debounced retry scheduled");
            }
          },
          debugLog,
        });
      } finally {
        if (refreshInFlight.get(key) === entry) refreshInFlight.delete(key);
      }
    })();
    entry.promise = p;
    refreshInFlight.set(key, entry);
    return p;
  }

  async function refreshIdleAccount(account: ManagedAccount) {
    if (!getAccountManager()) return;
    if (idleRefreshInFlight.has(account.id)) return;
    idleRefreshInFlight.add(account.id);
    const attemptedRefreshToken = account.refreshToken;
    try {
      try {
        await refreshAccountTokenSingleFlight(account, "idle");
        return;
      } catch (err) {
        let details = parseRefreshFailure(err);
        if (!(details.isInvalidGrant || details.isTerminalStatus)) {
          debugLog("idle refresh skipped after transient failure", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message,
          });
          return;
        }
        const diskAuth = await readDiskAccountAuth(account.id);
        const retryToken = diskAuth?.refreshToken;
        if (retryToken && retryToken !== attemptedRefreshToken && account.refreshToken === attemptedRefreshToken) {
          account.refreshToken = retryToken;
          if (diskAuth?.tokenUpdatedAt) account.tokenUpdatedAt = diskAuth.tokenUpdatedAt;
          else markTokenStateUpdated(account);
        }
        try {
          await refreshAccountTokenSingleFlight(account, "idle");
        } catch (retryErr) {
          details = parseRefreshFailure(retryErr);
          debugLog("idle refresh retry failed", {
            accountIndex: account.index,
            status: details.status,
            errorCode: details.errorCode,
            message: details.message,
          });
        }
      }
    } finally {
      idleRefreshInFlight.delete(account.id);
    }
  }

  function maybeRefreshIdleAccounts(activeAccount: ManagedAccount) {
    const accountManager = getAccountManager();
    if (!IDLE_REFRESH_ENABLED || !accountManager) return;
    const now = Date.now();
    const excluded = new Set([activeAccount.index]);
    const candidates = accountManager
      .getEnabledAccounts(excluded)
      .filter((acc) => !acc.expires || acc.expires <= now + IDLE_REFRESH_WINDOW_MS)
      .filter((acc) => {
        const last = idleRefreshLastAttempt.get(acc.id) ?? 0;
        return now - last >= IDLE_REFRESH_MIN_INTERVAL_MS;
      })
      .sort((a, b) => (a.expires ?? 0) - (b.expires ?? 0));
    const target = candidates[0];
    if (!target) return;
    idleRefreshLastAttempt.set(target.id, now);
    void refreshIdleAccount(target);
  }

  return {
    parseRefreshFailure,
    refreshAccountTokenSingleFlight,
    refreshIdleAccount,
    maybeRefreshIdleAccounts,
  };
}

export type RefreshHelpers = ReturnType<typeof createRefreshHelpers>;
