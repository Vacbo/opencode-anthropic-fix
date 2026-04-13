// ---------------------------------------------------------------------------
// Slash-command OAuth flows (login / reauth)
// ---------------------------------------------------------------------------

import { resolveIdentityFromOAuthExchange } from "../account-identity.js";
import { authorize, exchange } from "../oauth.js";
import { createDefaultStats, loadAccounts, saveAccounts } from "../storage.js";

export const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;

export interface PendingOAuthEntry {
    mode: "login" | "reauth";
    verifier: string;
    state?: string;
    targetIndex?: number;
    createdAt: number;
}

export interface OAuthFlowDeps {
    pendingSlashOAuth: Map<string, PendingOAuthEntry>;
    sendCommandMessage: (sessionID: string, message: string) => Promise<void>;
    reloadAccountManagerFromDisk: () => Promise<void>;
    persistOpenCodeAuth: (refresh: string, access: string | undefined, expires: number | undefined) => Promise<void>;
}

/**
 * Remove expired pending OAuth entries from the map.
 */
export function pruneExpiredPendingOAuth(pendingSlashOAuth: Map<string, PendingOAuthEntry>): void {
    const now = Date.now();
    for (const [key, entry] of pendingSlashOAuth) {
        if (now - entry.createdAt > PENDING_OAUTH_TTL_MS) {
            pendingSlashOAuth.delete(key);
        }
    }
}

/**
 * Begin a slash-command OAuth flow (login or reauth).
 * Sends the authorization URL to the user via sendCommandMessage.
 */
export async function startSlashOAuth(
    sessionID: string,
    mode: "login" | "reauth",
    targetIndex: number | undefined,
    deps: OAuthFlowDeps,
): Promise<void> {
    const { pendingSlashOAuth, sendCommandMessage } = deps;
    pruneExpiredPendingOAuth(pendingSlashOAuth);
    const { url, verifier, state } = await authorize("max");
    pendingSlashOAuth.set(sessionID, {
        mode,
        verifier,
        state,
        targetIndex,
        createdAt: Date.now(),
    });

    const action = mode === "login" ? "login" : `reauth ${(targetIndex ?? 0) + 1}`;
    const followup =
        mode === "login" ? "/anthropic login complete <code#state>" : "/anthropic reauth complete <code#state>";

    await sendCommandMessage(
        sessionID,
        [
            "▣ Anthropic OAuth",
            "",
            `Started ${action} flow.`,
            "Open this URL in your browser:",
            url,
            "",
            `Then run: ${followup}`,
            "(Paste the full authorization code, including #state)",
        ].join("\n"),
    );
}

/**
 * Complete a pending slash-command OAuth flow.
 */
export async function completeSlashOAuth(
    sessionID: string,
    code: string,
    deps: OAuthFlowDeps,
): Promise<{ ok: boolean; message: string }> {
    const { pendingSlashOAuth, reloadAccountManagerFromDisk, persistOpenCodeAuth } = deps;

    const pending = pendingSlashOAuth.get(sessionID);
    if (!pending) {
        pruneExpiredPendingOAuth(pendingSlashOAuth);
        return {
            ok: false,
            message: "No pending OAuth flow. Start with /anthropic login or /anthropic reauth <N>.",
        };
    }

    if (Date.now() - pending.createdAt > PENDING_OAUTH_TTL_MS) {
        pendingSlashOAuth.delete(sessionID);
        return {
            ok: false,
            message: "Pending OAuth flow expired. Start again with /anthropic login or /anthropic reauth <N>.",
        };
    }

    // Validate state parameter to prevent CSRF attacks
    const splits = code.split("#");
    if (pending.state && splits[1] && splits[1] !== pending.state) {
        pendingSlashOAuth.delete(sessionID);
        return {
            ok: false,
            message: "OAuth state mismatch — possible CSRF attack. Please try again.",
        };
    }

    const credentials = await exchange(code, pending.verifier);
    if (credentials.type === "failed") {
        return {
            ok: false,
            message: credentials.details
                ? `Token exchange failed (${credentials.details}).`
                : "Token exchange failed. The code may be invalid or expired.",
        };
    }

    const stored = (await loadAccounts()) ?? {
        version: 1,
        accounts: [],
        activeIndex: 0,
    };

    if (pending.mode === "login") {
        const existingIdx = stored.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
        if (existingIdx >= 0) {
            const acc = stored.accounts[existingIdx];
            const accIsCC = acc.source === "cc-keychain" || acc.source === "cc-file";
            acc.access = credentials.access;
            acc.expires = credentials.expires;
            acc.token_updated_at = Date.now();
            acc.enabled = true;
            acc.consecutiveFailures = 0;
            acc.lastFailureTime = null;
            acc.rateLimitResetTimes = {};
            if (!accIsCC) {
                if (credentials.email) acc.email = credentials.email;
                acc.identity = resolveIdentityFromOAuthExchange(credentials);
                acc.source = acc.source ?? "oauth";
            }
            await saveAccounts(stored);
            await persistOpenCodeAuth(acc.refreshToken, acc.access, acc.expires);
            await reloadAccountManagerFromDisk();
            pendingSlashOAuth.delete(sessionID);
            const name = acc.email || `Account ${existingIdx + 1}`;
            return {
                ok: true,
                message: `Updated existing account #${existingIdx + 1} (${name}).`,
            };
        }

        if (stored.accounts.length >= 10) {
            return {
                ok: false,
                message: "Maximum of 10 accounts reached. Remove one first.",
            };
        }

        const now = Date.now();
        stored.accounts.push({
            id: `${now}:${credentials.refresh.slice(0, 12)}`,
            email: credentials.email,
            identity: resolveIdentityFromOAuthExchange(credentials),
            refreshToken: credentials.refresh,
            access: credentials.access,
            expires: credentials.expires,
            token_updated_at: now,
            addedAt: now,
            lastUsed: 0,
            enabled: true,
            rateLimitResetTimes: {},
            consecutiveFailures: 0,
            lastFailureTime: null,
            stats: createDefaultStats(now),
            source: "oauth",
        });
        await saveAccounts(stored);
        const newAccount = stored.accounts[stored.accounts.length - 1];
        await persistOpenCodeAuth(newAccount.refreshToken, newAccount.access, newAccount.expires);
        await reloadAccountManagerFromDisk();
        pendingSlashOAuth.delete(sessionID);
        const label = credentials.email || `Account ${stored.accounts.length}`;
        return {
            ok: true,
            message: `Added account #${stored.accounts.length} (${label}).`,
        };
    }

    // reauth flow
    const idx = pending.targetIndex ?? -1;
    if (idx < 0 || idx >= stored.accounts.length) {
        pendingSlashOAuth.delete(sessionID);
        return {
            ok: false,
            message: "Target account no longer exists. Start reauth again.",
        };
    }

    const existing = stored.accounts[idx];
    const existingIsCC = existing.source === "cc-keychain" || existing.source === "cc-file";
    existing.refreshToken = credentials.refresh;
    existing.access = credentials.access;
    existing.expires = credentials.expires;
    existing.token_updated_at = Date.now();
    existing.enabled = true;
    existing.consecutiveFailures = 0;
    existing.lastFailureTime = null;
    existing.rateLimitResetTimes = {};
    if (!existingIsCC) {
        if (credentials.email) existing.email = credentials.email;
        existing.identity = resolveIdentityFromOAuthExchange(credentials);
        existing.source = existing.source ?? "oauth";
    }

    await saveAccounts(stored);
    await persistOpenCodeAuth(existing.refreshToken, existing.access, existing.expires);
    await reloadAccountManagerFromDisk();
    pendingSlashOAuth.delete(sessionID);
    const name = existing.email || `Account ${idx + 1}`;
    return {
        ok: true,
        message: `Re-authenticated account #${idx + 1} (${name}).`,
    };
}
