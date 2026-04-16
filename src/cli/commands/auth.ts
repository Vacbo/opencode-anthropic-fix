import { exec } from "node:child_process";
import { findByIdentity, resolveIdentityFromOAuthExchange } from "../../account-identity.js";
import { AccountManager } from "../../accounts.js";
import type { OAuthProfilePayload } from "../status-api.js";
import { fetchProfile, fetchUsage } from "../status-api.js";
import { loadConfig } from "../../config.js";
import { authorize, exchange, refreshToken, revoke } from "../../oauth.js";
import { createDefaultStats, getStoragePath, loadAccounts, saveAccounts } from "../../storage.js";
import { confirm, intro, isCancel, log, spinner, text } from "@clack/prompts";
import {
    c,
    fmtTokens,
    formatDuration,
    formatTimeAgo,
    pad,
    renderUsageLines,
    rpad,
    shortPath,
    USAGE_INDENT,
} from "../formatting.js";

type RefreshableAccount = {
    refreshToken: string;
    access?: string;
    expires?: number;
    token_updated_at?: number;
    tokenUpdatedAt?: number;
};
type UsageAccount = RefreshableAccount & {
    enabled: boolean;
};
type UsageFetchResult = {
    usage: Record<string, unknown> | null;
    error: string | null;
    profile: OAuthProfilePayload | null;
    profileError: string | null;
};
type LogoutOptions = { force?: boolean; all?: boolean };
type RemoveOptions = { force?: boolean };

export async function refreshAccessToken(account: RefreshableAccount) {
    try {
        const json = await refreshToken(account.refreshToken, {
            signal: AbortSignal.timeout(5000),
        });

        account.access = json.access_token;
        account.expires = Date.now() + json.expires_in * 1000;
        if (json.refresh_token) account.refreshToken = json.refresh_token;
        if ("tokenUpdatedAt" in account) {
            account.tokenUpdatedAt = Date.now();
        }
        if ("token_updated_at" in account) {
            account.token_updated_at = Date.now();
        }
        return json.access_token;
    } catch {
        return null;
    }
}

/**
 * Ensure an account has a valid access token and fetch its usage data.
 */
export async function ensureTokenAndFetchUsage(account: UsageAccount) {
    if (!account.enabled) {
        return { usage: null, error: null, profile: null, profileError: null, tokenRefreshed: false };
    }

    let token: string | undefined = account.access;
    let tokenRefreshed = false;

    if (!token || !account.expires || account.expires < Date.now()) {
        const refreshedToken = await refreshAccessToken(account);
        tokenRefreshed = !!refreshedToken;
        if (!refreshedToken) {
            return {
                usage: null,
                error: "token refresh failed",
                profile: null,
                profileError: null,
                tokenRefreshed: false,
            };
        }
        token = refreshedToken;
    }

    const [usageResult, profileResult] = await Promise.all([fetchUsage(token), fetchProfile(token)]);
    return {
        usage: usageResult.data,
        error: usageResult.error,
        profile: profileResult.data,
        profileError: profileResult.error,
        tokenRefreshed,
    };
}

/**
 * Open a URL in the user's default browser.
 * Best-effort: uses platform-specific command, silently fails on error.
 */
function openBrowser(url: string) {
    if (process.platform === "win32") {
        exec(`cmd /c start "" ${JSON.stringify(url)}`);
        return;
    }

    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${cmd} ${JSON.stringify(url)}`);
}

/**
 * Run the OAuth PKCE login flow from the CLI.
 * Opens browser, prompts for code, exchanges for tokens.
 */
async function runOAuthFlow() {
    const { url, verifier, state } = await authorize("max");

    log.info("Opening browser for Anthropic OAuth login...");
    log.info("If your browser didn't open, visit this URL:");
    log.info(url);

    openBrowser(url);

    const code = await text({
        message: "Paste the authorization code here:",
        placeholder: "auth-code#state",
    });
    if (isCancel(code)) {
        log.warn("Login cancelled.");
        return null;
    }

    const trimmed = code.trim();
    if (!trimmed) {
        log.error("Error: no authorization code provided.");
        return null;
    }

    const parts = trimmed.split("#");
    if (state && parts[1] && parts[1] !== state) {
        log.error("Error: OAuth state mismatch — possible CSRF attack.");
        return null;
    }

    const s = spinner();
    s.start("Exchanging authorization code for tokens...");
    const credentials = await exchange(trimmed, verifier);
    if (credentials.type === "failed") {
        if (credentials.details) {
            s.stop(`Token exchange failed (${credentials.details}).`);
        } else {
            s.stop("Token exchange failed. The code may be invalid or expired.");
        }
        return null;
    }

    s.stop("Token exchange successful.");

    return {
        refresh: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        email: credentials.email,
        accountUuid: credentials.accountUuid,
        organizationUuid: credentials.organizationUuid,
    };
}

/**
 * Login: add a new account via browser OAuth flow.
 */
export async function cmdLogin() {
    if (!process.stdin.isTTY) {
        log.error("Error: 'login' requires an interactive terminal.");
        return 1;
    }

    intro("Login — Add a new account");

    const stored = await loadAccounts();
    const credentials = await runOAuthFlow();
    if (!credentials) return 1;

    const storage = stored || { version: 1, accounts: [], activeIndex: 0 };
    const identity = resolveIdentityFromOAuthExchange(credentials);

    const existing =
        findByIdentity(storage.accounts, identity) ||
        storage.accounts.find((account) => account.refreshToken === credentials.refresh);

    if (existing) {
        const existingIdx = storage.accounts.indexOf(existing);
        const existingIsCC = existing.source === "cc-keychain" || existing.source === "cc-file";
        existing.refreshToken = credentials.refresh;
        existing.access = credentials.access;
        existing.expires = credentials.expires;
        existing.accountUuid = credentials.accountUuid ?? existing.accountUuid;
        existing.organizationUuid = credentials.organizationUuid ?? existing.organizationUuid;
        existing.token_updated_at = Date.now();
        existing.enabled = true;
        if (!existingIsCC) {
            if (credentials.email) existing.email = credentials.email;
            existing.identity = identity;
            existing.source = existing.source ?? "oauth";
        }
        await saveAccounts(storage);

        const label = credentials.email || existing.email || `Account ${existingIdx + 1}`;
        log.success(`Updated existing account #${existingIdx + 1} (${label}).`);
        return 0;
    }

    if (storage.accounts.length >= 10) {
        log.error("Error: maximum of 10 accounts reached. Remove one first.");
        return 1;
    }

    const now = Date.now();
    storage.accounts.push({
        id: `${now}:${credentials.refresh.slice(0, 12)}`,
        email: credentials.email,
        identity,
        refreshToken: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        accountUuid: credentials.accountUuid,
        organizationUuid: credentials.organizationUuid,
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

    await saveAccounts(storage);

    const label = credentials.email || `Account ${storage.accounts.length}`;
    log.success(`Added account #${storage.accounts.length} (${label}).`);
    log.info(`${storage.accounts.length} account(s) total.`);
    return 0;
}

/**
 * Logout: revoke tokens and remove an account, or all accounts.
 */
export async function cmdLogout(arg?: string, opts: LogoutOptions = {}) {
    if (opts.all) {
        return cmdLogoutAll(opts);
    }

    const n = parseInt(arg || "", 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'logout 2') or --all.");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`);
        return 1;
    }

    const label = stored.accounts[idx].email || `Account ${n}`;

    if (!opts.force) {
        if (!process.stdin.isTTY) {
            log.error("Error: use --force to logout in non-interactive mode.");
            return 1;
        }

        const shouldLogout = await confirm({
            message: `Logout account #${n} (${label})? This will revoke tokens and remove the account.`,
        });
        if (isCancel(shouldLogout) || !shouldLogout) {
            log.info("Cancelled.");
            return 0;
        }
    }

    const revoked = await revoke(stored.accounts[idx].refreshToken);
    if (revoked) {
        log.info("Token revoked server-side.");
    } else {
        log.info("Token revocation skipped (server may not support it).");
    }

    stored.accounts.splice(idx, 1);

    if (stored.accounts.length === 0) {
        stored.activeIndex = 0;
    } else if (stored.activeIndex >= stored.accounts.length) {
        stored.activeIndex = stored.accounts.length - 1;
    } else if (stored.activeIndex > idx) {
        stored.activeIndex--;
    }

    await saveAccounts(stored);
    log.success(`Logged out account #${n} (${label}).`);

    if (stored.accounts.length > 0) {
        log.info(`${stored.accounts.length} account(s) remaining.`);
    } else {
        log.info("No accounts remaining. Run 'login' to add one.");
    }

    return 0;
}

async function cmdLogoutAll(opts: Pick<LogoutOptions, "force"> = {}) {
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.info("No accounts to logout.");
        return 0;
    }

    const count = stored.accounts.length;

    if (!opts.force) {
        if (!process.stdin.isTTY) {
            log.error("Error: use --force to logout all in non-interactive mode.");
            return 1;
        }

        const shouldLogoutAll = await confirm({
            message: `Logout all ${count} account(s)? This will revoke tokens and remove all accounts.`,
        });
        if (isCancel(shouldLogoutAll) || !shouldLogoutAll) {
            log.info("Cancelled.");
            return 0;
        }
    }

    const results = await Promise.allSettled(stored.accounts.map((account) => revoke(account.refreshToken)));
    const revokedCount = results.filter((result) => result.status === "fulfilled" && result.value === true).length;

    if (revokedCount > 0) {
        log.info(`Revoked ${revokedCount} of ${count} token(s) server-side.`);
    }

    await saveAccounts({ version: 1, accounts: [], activeIndex: 0 });
    log.success(`Logged out all ${count} account(s).`);
    return 0;
}

/**
 * Reauth: re-authenticate an existing account with fresh OAuth tokens.
 */
export async function cmdReauth(arg: string) {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'reauth 1')");
        return 1;
    }

    if (!process.stdin.isTTY) {
        log.error("Error: 'reauth' requires an interactive terminal.");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`);
        return 1;
    }

    const existing = stored.accounts[idx];
    const existingIsCC = existing.source === "cc-keychain" || existing.source === "cc-file";
    const wasDisabled = !existing.enabled;
    const oldLabel = existing.email || `Account ${n}`;
    log.info(`Re-authenticating account #${n} (${oldLabel})...`);

    const credentials = await runOAuthFlow();
    if (!credentials) return 1;

    existing.refreshToken = credentials.refresh;
    existing.access = credentials.access;
    existing.expires = credentials.expires;
    existing.accountUuid = credentials.accountUuid ?? existing.accountUuid;
    existing.organizationUuid = credentials.organizationUuid ?? existing.organizationUuid;
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

    const newLabel = credentials.email || `Account ${n}`;
    log.success(`Re-authenticated account #${n} (${newLabel}).`);
    if (wasDisabled) {
        log.info("Account has been re-enabled.");
    }

    return 0;
}

/**
 * Refresh: attempt a token refresh for an account without browser interaction.
 */
export async function cmdRefresh(arg: string) {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'refresh 1')");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`);
        return 1;
    }

    const account = stored.accounts[idx];
    const label = account.email || `Account ${n}`;

    const s = spinner();
    s.start(`Refreshing token for account #${n} (${label})...`);

    const token = await refreshAccessToken(account);
    if (!token) {
        s.stop(`Token refresh failed for account #${n}.`);
        log.error("The refresh token may be invalid or expired.");
        log.error(`Try: opencode-anthropic-auth reauth ${n}`);
        return 1;
    }

    const wasDisabled = !account.enabled;
    account.enabled = true;
    account.consecutiveFailures = 0;
    account.lastFailureTime = null;
    account.rateLimitResetTimes = {};

    await saveAccounts(stored);

    const expiresIn = account.expires ? formatDuration(account.expires - Date.now()) : "unknown";
    s.stop("Token refreshed.");
    log.success(`Token refreshed for account #${n} (${label}).`);
    log.info(`New token expires in ${expiresIn}.`);
    if (wasDisabled) {
        log.info("Account has been re-enabled.");
    }

    return 0;
}

/**
 * List all accounts with full status table and live usage quotas.
 */
export async function cmdList() {
    const config = loadConfig();
    const accountManager = await AccountManager.load(config, null);
    const accounts = accountManager.getManagedAccounts();
    if (accounts.length === 0) {
        log.warn("No accounts configured.");
        log.info(`Storage: ${shortPath(getStoragePath())}`);
        log.info("Run 'opencode auth login' and select 'Claude Pro/Max' to add accounts.");
        return 1;
    }

    const now = Date.now();
    const activeIndex = accountManager.getCurrentIndex();

    const s = spinner();
    s.start("Fetching usage quotas...");
    const usageResults = await Promise.allSettled(accounts.map((account) => ensureTokenAndFetchUsage(account)));
    s.stop("Usage quotas fetched.");

    let anyRefreshed = false;
    for (const result of usageResults) {
        if (result.status === "fulfilled" && result.value.tokenRefreshed) {
            anyRefreshed = true;
        }
    }

    if (anyRefreshed) {
        await accountManager.saveToDisk().catch((error) => {
            console.error("[opencode-anthropic-auth] failed to persist refreshed tokens:", error);
        });
    }

    log.message(c.bold("Anthropic Multi-Account Status"));
    log.message(
        "  " +
            pad(c.dim("#"), 5) +
            pad(c.dim("Account"), 22) +
            pad(c.dim("Status"), 14) +
            pad(c.dim("Failures"), 11) +
            c.dim("Rate Limit"),
    );
    log.message(c.dim("  " + "─".repeat(62)));

    for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i]!;
        const isActive = account.index === activeIndex;
        const result = usageResults[i];
        const profile = result?.status === "fulfilled" ? result.value.profile : null;
        const label =
            account.email ||
            profile?.account?.email ||
            profile?.account?.display_name ||
            profile?.account?.full_name ||
            account.label ||
            `Account ${i + 1}`;
        const status = !account.enabled ? c.gray("○ disabled") : isActive ? c.green("● active") : c.cyan("● ready");
        const failures = !account.enabled
            ? c.dim("—")
            : account.consecutiveFailures > 0
              ? c.yellow(String(account.consecutiveFailures))
              : c.dim("0");

        let rateLimit: string;
        if (!account.enabled) {
            rateLimit = c.dim("—");
        } else {
            const maxReset = Math.max(0, ...Object.values(account.rateLimitResetTimes || {}));
            rateLimit = maxReset > now ? c.yellow(`\u26A0 ${formatDuration(maxReset - now)}`) : c.dim("—");
        }

        log.message(
            "  " + pad(c.bold(String(i + 1)), 5) + pad(label, 22) + pad(status, 14) + pad(failures, 11) + rateLimit,
        );

        if (account.enabled) {
            const usage = result.status === "fulfilled" ? result.value.usage : null;
            const usageError = result.status === "fulfilled" ? result.value.error : "request failed";
            if (usage) {
                const lines = renderUsageLines(usage);
                for (const line of lines) {
                    log.message(line);
                }
            } else {
                log.message(
                    c.dim(`${USAGE_INDENT}quotas: ${usageError ? `unavailable (${usageError})` : "unavailable"}`),
                );
            }
        }

        if (i < accounts.length - 1) {
            log.message("");
        }
    }

    log.message("");

    const enabled = accounts.filter((account) => account.enabled).length;
    const disabled = accounts.length - enabled;
    const parts = [
        `Strategy: ${c.cyan(config.account_selection_strategy)}`,
        `${c.bold(String(enabled))} of ${accounts.length} enabled`,
    ];
    if (disabled > 0) {
        parts.push(`${c.yellow(String(disabled))} disabled`);
    }
    log.info(parts.join(c.dim(" | ")));
    log.info(`Storage: ${shortPath(getStoragePath())}`);

    return 0;
}

/**
 * Show compact one-liner status.
 */
export async function cmdStatus() {
    const config = loadConfig();
    const accountManager = await AccountManager.load(config, null);
    const accounts = accountManager.getManagedAccounts();
    if (accounts.length === 0) {
        console.log("anthropic: no accounts configured");
        return 1;
    }

    const total = accounts.length;
    const enabled = accounts.filter((account) => account.enabled).length;
    const now = Date.now();

    let rateLimited = 0;
    for (const account of accounts) {
        if (!account.enabled) continue;
        const maxReset = Math.max(0, ...Object.values(account.rateLimitResetTimes || {}));
        if (maxReset > now) rateLimited++;
    }

    let line = `anthropic: ${total} account${total !== 1 ? "s" : ""} (${enabled} active)`;
    line += `, strategy: ${config.account_selection_strategy}`;
    line += `, next: #${accountManager.getCurrentIndex() + 1}`;
    if (rateLimited > 0) {
        line += `, ${rateLimited} rate-limited`;
    }

    console.log(line);
    return 0;
}

/**
 * Switch active account.
 */
export async function cmdSwitch(arg?: string) {
    const n = parseInt(arg || "", 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'switch 2')");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist. You have ${stored.accounts.length} account(s).`);
        return 1;
    }

    if (!stored.accounts[idx].enabled) {
        log.error(`Warning: account ${n} is disabled. Enable it first with 'enable ${n}'.`);
        return 1;
    }

    stored.activeIndex = idx;
    await saveAccounts(stored);

    const label = stored.accounts[idx].email || `Account ${n}`;
    log.success(`Switched active account to #${n} (${label}).`);
    return 0;
}

/**
 * Enable a disabled account.
 */
export async function cmdEnable(arg?: string) {
    const n = parseInt(arg || "", 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'enable 3')");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist.`);
        return 1;
    }

    if (stored.accounts[idx].enabled) {
        log.info(`Account ${n} is already enabled.`);
        return 0;
    }

    stored.accounts[idx].enabled = true;
    await saveAccounts(stored);

    const label = stored.accounts[idx].email || `Account ${n}`;
    log.success(`Enabled account #${n} (${label}).`);
    return 0;
}

/**
 * Disable an account.
 */
export async function cmdDisable(arg?: string) {
    const n = parseInt(arg || "", 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'disable 3')");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist.`);
        return 1;
    }

    if (!stored.accounts[idx].enabled) {
        log.info(`Account ${n} is already disabled.`);
        return 0;
    }

    const enabledCount = stored.accounts.filter((account) => account.enabled).length;
    if (enabledCount <= 1) {
        log.error("Error: cannot disable the last enabled account.");
        return 1;
    }

    stored.accounts[idx].enabled = false;

    const label = stored.accounts[idx].email || `Account ${n}`;
    let switchedTo: number | null = null;

    if (idx === stored.activeIndex) {
        const nextEnabled = stored.accounts.findIndex((account) => account.enabled);
        if (nextEnabled >= 0) {
            stored.activeIndex = nextEnabled;
            switchedTo = nextEnabled;
        }
    }

    await saveAccounts(stored);

    log.warn(`Disabled account #${n} (${label}).`);
    if (switchedTo !== null) {
        const nextLabel = stored.accounts[switchedTo].email || `Account ${switchedTo + 1}`;
        log.info(`Active account switched to #${switchedTo + 1} (${nextLabel}).`);
    }

    return 0;
}

/**
 * Reset rate-limit and failure tracking.
 */
export async function cmdReset(arg?: string) {
    if (!arg) {
        log.error("Error: provide an account number or 'all' (e.g., 'reset 1' or 'reset all')");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    if (arg.toLowerCase() === "all") {
        let count = 0;
        for (const account of stored.accounts) {
            account.rateLimitResetTimes = {};
            account.consecutiveFailures = 0;
            account.lastFailureTime = null;
            count++;
        }
        await saveAccounts(stored);
        log.success(`Reset tracking for all ${count} account(s).`);
        return 0;
    }

    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number or 'all'.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist.`);
        return 1;
    }

    stored.accounts[idx].rateLimitResetTimes = {};
    stored.accounts[idx].consecutiveFailures = 0;
    stored.accounts[idx].lastFailureTime = null;
    await saveAccounts(stored);

    const label = stored.accounts[idx].email || `Account ${n}`;
    log.success(`Reset tracking for account #${n} (${label}).`);
    return 0;
}

/**
 * Show per-account usage statistics.
 */
export async function cmdStats() {
    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.warn("No accounts configured.");
        return 1;
    }

    const widths = { num: 4, name: 22, val: 10 };
    const rule = c.dim("  " + "─".repeat(74));

    log.message(c.bold("Anthropic Account Usage"));
    log.message(
        "  " +
            pad(c.dim("#"), widths.num) +
            pad(c.dim("Account"), widths.name) +
            rpad(c.dim("Requests"), widths.val) +
            rpad(c.dim("Input"), widths.val) +
            rpad(c.dim("Output"), widths.val) +
            rpad(c.dim("Cache R"), widths.val) +
            rpad(c.dim("Cache W"), widths.val),
    );
    log.message(rule);

    let totalRequests = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let oldestReset = Infinity;

    for (let i = 0; i < stored.accounts.length; i++) {
        const account = stored.accounts[i];
        const stats = account.stats || createDefaultStats();
        const marker = i === stored.activeIndex ? c.green("●") : " ";
        const number = `${marker} ${i + 1}`;
        const name = account.email || `Account ${i + 1}`;

        log.message(
            "  " +
                pad(number, widths.num) +
                pad(name, widths.name) +
                rpad(String(stats.requests), widths.val) +
                rpad(fmtTokens(stats.inputTokens), widths.val) +
                rpad(fmtTokens(stats.outputTokens), widths.val) +
                rpad(fmtTokens(stats.cacheReadTokens), widths.val) +
                rpad(fmtTokens(stats.cacheWriteTokens), widths.val),
        );

        totalRequests += stats.requests;
        totalInput += stats.inputTokens;
        totalOutput += stats.outputTokens;
        totalCacheRead += stats.cacheReadTokens;
        totalCacheWrite += stats.cacheWriteTokens;
        if (stats.lastReset < oldestReset) oldestReset = stats.lastReset;
    }

    if (stored.accounts.length > 1) {
        log.message(rule);
        log.message(
            c.bold(
                "  " +
                    pad("", widths.num) +
                    pad("Total", widths.name) +
                    rpad(String(totalRequests), widths.val) +
                    rpad(fmtTokens(totalInput), widths.val) +
                    rpad(fmtTokens(totalOutput), widths.val) +
                    rpad(fmtTokens(totalCacheRead), widths.val) +
                    rpad(fmtTokens(totalCacheWrite), widths.val),
            ),
        );
    }

    if (oldestReset < Infinity) {
        log.message(c.dim(`Tracking since: ${new Date(oldestReset).toLocaleString()} (${formatTimeAgo(oldestReset)})`));
    }

    return 0;
}

/**
 * Remove an account permanently.
 * @returns exit code
 */
export async function cmdRemove(arg?: string, opts: RemoveOptions = {}) {
    const n = parseInt(arg || "", 10);
    if (isNaN(n) || n < 1) {
        log.error("Error: provide a valid account number (e.g., 'remove 2')");
        return 1;
    }

    const stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
        log.error("Error: no accounts configured.");
        return 1;
    }

    const idx = n - 1;
    if (idx >= stored.accounts.length) {
        log.error(`Error: account ${n} does not exist.`);
        return 1;
    }

    const label = stored.accounts[idx]!.email || `Account ${n}`;

    if (!opts.force) {
        if (!process.stdin.isTTY) {
            log.error("Error: use --force to remove accounts in non-interactive mode.");
            return 1;
        }
        const shouldRemove = await confirm({
            message: `Remove account #${n} (${label})? This cannot be undone.`,
        });
        if (isCancel(shouldRemove) || !shouldRemove) {
            log.info("Cancelled.");
            return 0;
        }
    }

    stored.accounts.splice(idx, 1);

    if (stored.accounts.length === 0) {
        stored.activeIndex = 0;
    } else if (stored.activeIndex >= stored.accounts.length) {
        stored.activeIndex = stored.accounts.length - 1;
    } else if (stored.activeIndex > idx) {
        stored.activeIndex--;
    }

    await saveAccounts(stored);
    log.success(`Removed account #${n} (${label}).`);

    if (stored.accounts.length > 0) {
        log.info(`${stored.accounts.length} account(s) remaining.`);
    } else {
        log.info("No accounts remaining. Run 'opencode auth login' to add one.");
    }

    return 0;
}

/**
 * Show help for auth and account command groups.
 */
export function cmdAuthGroupHelp(group: "auth" | "account") {
    const bin = "opencode-anthropic-auth";

    switch (group) {
        case "auth":
            console.log(`
${c.bold("Auth Commands")}

  ${pad(c.cyan("login"), 20)}Add a new account via browser OAuth flow (alias: ln)
  ${pad(c.cyan("logout") + " <N>", 20)}Revoke tokens and remove account N (alias: lo)
  ${pad(c.cyan("logout") + " --all", 20)}Revoke all tokens and clear all accounts
  ${pad(c.cyan("reauth") + " <N>", 20)}Re-authenticate account N with fresh tokens (alias: ra)
  ${pad(c.cyan("refresh") + " <N>", 20)}Attempt token refresh without browser (alias: rf)

${c.dim("Examples:")}
  ${bin} auth login
  ${bin} auth logout 2
  ${bin} auth reauth 1
`);
            return 0;
        case "account":
            console.log(`
${c.bold("Account Commands")}

  ${pad(c.cyan("list"), 20)}Show all accounts with status (alias: ls)
  ${pad(c.cyan("switch") + " <N>", 20)}Set account N as active (alias: sw)
  ${pad(c.cyan("enable") + " <N>", 20)}Enable a disabled account (alias: en)
  ${pad(c.cyan("disable") + " <N>", 20)}Disable an account (alias: dis)
  ${pad(c.cyan("remove") + " <N>", 20)}Remove an account permanently (alias: rm)
  ${pad(c.cyan("reset"), 20)}Clear rate-limit / failure tracking

${c.dim("Examples:")}
  ${bin} account list
  ${bin} account switch 2
  ${bin} account disable 3
`);
            return 0;
    }
}
