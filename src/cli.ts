#!/usr/bin/env bun
/**
 * CLI for managing Anthropic multi-account OAuth configuration.
 *
 * Usage:
 *   opencode-anthropic-auth [group] [command] [args]
 *   opencode-anthropic-auth [command] [args] (legacy format, still supported)
 *   oaa [group] [command] [args] (short alias)
 *
 * Command Groups:
 *   auth              Authentication: login, logout, reauth, refresh
 *   account           Account management: list, switch, enable, disable, remove, reset
 *   usage             Usage statistics: stats, reset-stats, status
 *   config            Configuration: show, strategy
 *   manage            Interactive account management menu
 *
 * Auth Commands:
 *   login             Add a new account via browser OAuth flow
 *   logout <N>        Revoke tokens and remove account N
 *   logout --all      Revoke all tokens and clear all accounts
 *   reauth <N>        Re-authenticate account N with fresh OAuth tokens
 *   refresh <N>       Attempt token refresh (no browser needed)
 *
 * Account Commands:
 *   list              Show all accounts with status (default)
 *   switch <N>        Set account N as active
 *   enable <N>        Enable a disabled account
 *   disable <N>       Disable an account (skipped in rotation)
 *   remove <N>        Remove an account permanently
 *   reset <N|all>     Clear rate-limit / failure tracking
 *
 * Usage Commands:
 *   stats             Show per-account usage statistics
 *   reset-stats [N|all] Reset usage statistics
 *   status            Compact one-liner for scripts/prompts
 *
 * Config Commands:
 *   config            Show current configuration and file paths
 *   strategy [name]   Show or change account selection strategy
 *
 * Manage Commands:
 *   manage            Interactive account management menu
 *   help              Show this help message
 *
 * Group Help:
 *   auth help         Show auth commands
 *   account help      Show account commands
 *   usage help        Show usage commands
 *   config help       Show config commands
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { exec } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CLIENT_ID, getConfigPath, loadConfig, saveConfig, VALID_STRATEGIES } from "./config.js";
import { authorize, exchange, revoke } from "./oauth.js";
import { createDefaultStats, getStoragePath, loadAccounts, saveAccounts } from "./storage.js";
import { text, confirm, select, spinner, intro, isCancel, log, note } from "@clack/prompts";

// ---------------------------------------------------------------------------
// Color helpers — zero dependencies, respects NO_COLOR / TTY
// ---------------------------------------------------------------------------

let USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;

/** @param {string} code @param {string} text @returns {string} */
const ansi = (code: string, text: string) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

const c = {
  bold: (t: string) => ansi("1", t),
  dim: (t: string) => ansi("2", t),
  green: (t: string) => ansi("32", t),
  yellow: (t: string) => ansi("33", t),
  cyan: (t: string) => ansi("36", t),
  red: (t: string) => ansi("31", t),
  gray: (t: string) => ansi("90", t),
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format milliseconds as a human-readable duration.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms: number) {
  if (ms <= 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return remainSec > 0 ? `${minutes}m ${remainSec}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/**
 * Format a timestamp as relative time ago.
 * @param {number} timestamp
 * @returns {string}
 */
export function formatTimeAgo(timestamp: number | null | undefined) {
  if (!timestamp || timestamp === 0) return "never";
  const ms = Date.now() - timestamp;
  if (ms < 0) return "just now";
  return `${formatDuration(ms)} ago`;
}

/**
 * Shorten a path by replacing home directory with ~.
 * @param {string} p
 * @returns {string}
 */
function shortPath(p: string) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

/**
 * Strip ANSI escape codes from a string to get its visible content.
 * @param {string} str
 * @returns {string}
 */
function stripAnsi(str: string) {
  // eslint-disable-next-line no-control-regex
  return str.replace(new RegExp("\x1b\\[[0-9;]*m", "g"), "");
}

/**
 * Left-pad a string to a fixed visible width, accounting for ANSI escape codes.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function pad(str: string, width: number) {
  const diff = width - stripAnsi(str).length;
  return diff > 0 ? str + " ".repeat(diff) : str;
}

/**
 * Right-align a string to a fixed visible width, accounting for ANSI escape codes.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function rpad(str: string, width: number) {
  const diff = width - stripAnsi(str).length;
  return diff > 0 ? " ".repeat(diff) + str : str;
}

// ---------------------------------------------------------------------------
// Usage quota helpers
// ---------------------------------------------------------------------------

/**
 * Refresh an account's OAuth access token.
 * Mutates the account object in-place and returns the new access token.
 * @param {{ refreshToken: string, access?: string, expires?: number }} account
 * @returns {Promise<string | null>}
 */
export async function refreshAccessToken(account: Record<string, any>) {
  try {
    const resp = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const json: any = await resp.json();
    account.access = json.access_token;
    account.expires = Date.now() + json.expires_in * 1000;
    if (json.refresh_token) account.refreshToken = json.refresh_token;
    account.token_updated_at = Date.now();
    return json.access_token;
  } catch {
    return null;
  }
}

/**
 * Fetch usage quotas from the Anthropic OAuth usage endpoint.
 * @param {string} accessToken
 * @returns {Promise<Record<string, any> | null>}
 */
export async function fetchUsage(accessToken: string) {
  try {
    const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}

/**
 * Ensure an account has a valid access token and fetch its usage data.
 * @param {{ refreshToken: string, access?: string, expires?: number, enabled: boolean }} account
 * @returns {Promise<{ usage: Record<string, any> | null, tokenRefreshed: boolean }>}
 */
export async function ensureTokenAndFetchUsage(account: Record<string, any>) {
  if (!account.enabled) return { usage: null, tokenRefreshed: false };

  let token = account.access;
  let tokenRefreshed = false;

  if (!token || !account.expires || account.expires < Date.now()) {
    token = await refreshAccessToken(account);
    tokenRefreshed = !!token;
    if (!token) return { usage: null, tokenRefreshed: false };
  }

  const usage = await fetchUsage(token);
  return { usage, tokenRefreshed };
}

/**
 * Render a progress bar of a given width for a utilization percentage (0–100).
 * @param {number} utilization - percentage (0 to 100)
 * @param {number} [width=10] - bar character width
 * @returns {string}
 */
export function renderBar(utilization: number, width = 10) {
  const pct = Math.max(0, Math.min(100, utilization));
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;

  let bar: string;
  if (pct >= 90) {
    bar = c.red("█".repeat(filled)) + c.dim("░".repeat(empty));
  } else if (pct >= 70) {
    bar = c.yellow("█".repeat(filled)) + c.dim("░".repeat(empty));
  } else {
    bar = c.green("█".repeat(filled)) + c.dim("░".repeat(empty));
  }
  return bar;
}

/**
 * Format an ISO 8601 reset timestamp as a relative duration from now.
 * @param {string} isoString
 * @returns {string}
 */
export function formatResetTime(isoString: string) {
  const resetMs = new Date(isoString).getTime();
  const remaining = resetMs - Date.now();
  if (remaining <= 0) return "now";
  return formatDuration(remaining);
}

/**
 * Known usage quota buckets and their display labels.
 * Order determines display order.
 */
const QUOTA_BUCKETS = [
  { key: "five_hour", label: "5h" },
  { key: "seven_day", label: "7d" },
  { key: "seven_day_sonnet", label: "Sonnet 7d" },
  { key: "seven_day_opus", label: "Opus 7d" },
  { key: "seven_day_oauth_apps", label: "OAuth Apps 7d" },
  { key: "seven_day_cowork", label: "Cowork 7d" },
];

const USAGE_INDENT = "       ";
const USAGE_LABEL_WIDTH = 13;

/**
 * Render usage quota lines for an account.
 * Returns an array of pre-formatted strings (one per non-null bucket).
 * @param {Record<string, any>} usage
 * @returns {string[]}
 */
export function renderUsageLines(usage: Record<string, any>) {
  const lines = [];
  for (const { key, label } of QUOTA_BUCKETS) {
    const bucket = usage[key];
    if (!bucket || bucket.utilization == null) continue;

    const pct = bucket.utilization;
    const bar = renderBar(pct);
    const pctStr = pad(String(Math.round(pct)) + "%", 4);
    const reset = bucket.resets_at ? c.dim(`resets in ${formatResetTime(bucket.resets_at)}`) : "";

    lines.push(`${USAGE_INDENT}${pad(label, USAGE_LABEL_WIDTH)} ${bar} ${pctStr}${reset ? ` ${reset}` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Browser opener
// ---------------------------------------------------------------------------

/**
 * Open a URL in the user's default browser.
 * Best-effort: uses platform-specific command, silently fails on error.
 * @param {string} url
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
 * @returns {Promise<{refresh: string, access: string, expires: number, email?: string} | null>}
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
  const trimmed = (code as string).trim();
  if (!trimmed) {
    log.error("Error: no authorization code provided.");
    return null;
  }

  // Validate OAuth state to prevent CSRF
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
  };
}

// ---------------------------------------------------------------------------
// Auth commands (login, logout, reauth, refresh)
// ---------------------------------------------------------------------------

/**
 * Login: add a new account via browser OAuth flow.
 * @returns {Promise<number>} exit code
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

  // Load or create storage
  const storage = stored || { version: 1, accounts: [], activeIndex: 0 };

  // Check for duplicate refresh token
  const existingIdx = storage.accounts.findIndex((acc) => acc.refreshToken === credentials.refresh);
  if (existingIdx >= 0) {
    // Update existing account
    storage.accounts[existingIdx].access = credentials.access;
    storage.accounts[existingIdx].expires = credentials.expires;
    if (credentials.email) storage.accounts[existingIdx].email = credentials.email;
    storage.accounts[existingIdx].enabled = true;
    await saveAccounts(storage);

    const label = credentials.email || `Account ${existingIdx + 1}`;
    log.success(`Updated existing account #${existingIdx + 1} (${label}).`);
    return 0;
  }

  if (storage.accounts.length >= 10) {
    log.error("Error: maximum of 10 accounts reached. Remove one first.");
    return 1;
  }

  // Add new account
  const now = Date.now();
  storage.accounts.push({
    id: `${now}:${credentials.refresh.slice(0, 12)}`,
    email: credentials.email,
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
  });

  // If this is the first account, it's already active at index 0
  await saveAccounts(storage);

  const label = credentials.email || `Account ${storage.accounts.length}`;
  log.success(`Added account #${storage.accounts.length} (${label}).`);
  log.info(`${storage.accounts.length} account(s) total.`);
  return 0;
}

/**
 * Logout: revoke tokens and remove an account, or all accounts.
 * @param {string} arg - Account number
 * @param {object} [opts]
 * @param {boolean} [opts.force] Skip confirmation prompt
 * @param {boolean} [opts.all] Logout all accounts
 * @returns {Promise<number>} exit code
 */
export async function cmdLogout(arg?: string, opts: { force?: boolean; all?: boolean } = {}) {
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

  // Confirm unless --force
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

  // Attempt token revocation (best-effort)
  const revoked = await revoke(stored.accounts[idx].refreshToken);
  if (revoked) {
    log.info("Token revoked server-side.");
  } else {
    log.info("Token revocation skipped (server may not support it).");
  }

  // Remove the account
  stored.accounts.splice(idx, 1);

  // Adjust active index
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

/**
 * Logout all accounts: revoke all tokens and clear storage.
 * @param {object} [opts]
 * @param {boolean} [opts.force] Skip confirmation prompt
 * @returns {Promise<number>} exit code
 */
async function cmdLogoutAll(opts: { force?: boolean } = {}) {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    log.info("No accounts to logout.");
    return 0;
  }

  const count = stored.accounts.length;

  // Confirm unless --force
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

  // Attempt token revocation for each account (best-effort, in parallel)
  const results = await Promise.allSettled(stored.accounts.map((acc) => revoke(acc.refreshToken)));
  const revokedCount = results.filter((r) => r.status === "fulfilled" && r.value === true).length;

  if (revokedCount > 0) {
    log.info(`Revoked ${revokedCount} of ${count} token(s) server-side.`);
  }

  // Write explicit empty state so running plugin instances reconcile immediately.
  await saveAccounts({ version: 1, accounts: [], activeIndex: 0 });
  log.success(`Logged out all ${count} account(s).`);

  return 0;
}

/**
 * Reauth: re-authenticate an existing account with fresh OAuth tokens.
 * @param {string} arg - Account number
 * @returns {Promise<number>} exit code
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
  const wasDisabled = !existing.enabled;
  const oldLabel = existing.email || `Account ${n}`;
  log.info(`Re-authenticating account #${n} (${oldLabel})...`);

  const credentials = await runOAuthFlow();
  if (!credentials) return 1;

  // Update the account at the target index with fresh tokens
  existing.refreshToken = credentials.refresh;
  existing.access = credentials.access;
  existing.expires = credentials.expires;
  if (credentials.email) existing.email = credentials.email;

  // Re-enable and reset failure tracking
  existing.enabled = true;
  existing.consecutiveFailures = 0;
  existing.lastFailureTime = null;
  existing.rateLimitResetTimes = {};

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
 * @param {string} arg - Account number
 * @returns {Promise<number>} exit code
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

  // Re-enable if disabled and reset failure tracking
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * List all accounts with full status table and live usage quotas.
 * @returns {Promise<number>} exit code
 */
export async function cmdList() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    log.warn("No accounts configured.");
    log.info(`Storage: ${shortPath(getStoragePath())}`);
    log.info("Run 'opencode auth login' and select 'Claude Pro/Max' to add accounts.");
    return 1;
  }

  const config = loadConfig();
  const now = Date.now();

  // Fetch usage quotas for all enabled accounts in parallel
  const s = spinner();
  s.start("Fetching usage quotas...");
  const usageResults = await Promise.allSettled(stored.accounts.map((acc) => ensureTokenAndFetchUsage(acc)));
  s.stop("Usage quotas fetched.");

  // If any tokens were refreshed, persist them back to disk
  let anyRefreshed = false;
  for (const result of usageResults) {
    if (result.status === "fulfilled" && result.value.tokenRefreshed) {
      anyRefreshed = true;
    }
  }
  if (anyRefreshed) {
    await saveAccounts(stored).catch(() => {});
  }

  log.message(c.bold("Anthropic Multi-Account Status"));

  // Header
  log.message(
    "  " +
      pad(c.dim("#"), 5) +
      pad(c.dim("Account"), 22) +
      pad(c.dim("Status"), 14) +
      pad(c.dim("Failures"), 11) +
      c.dim("Rate Limit"),
  );
  log.message(c.dim("  " + "─".repeat(62)));

  for (let i = 0; i < stored.accounts.length; i++) {
    const acc = stored.accounts[i];
    const isActive = i === stored.activeIndex;
    const num = String(i + 1);

    // Label
    const label = acc.email || `Account ${i + 1}`;

    // Status
    let status: string;
    if (!acc.enabled) {
      status = c.gray("○ disabled");
    } else if (isActive) {
      status = c.green("● active");
    } else {
      status = c.cyan("● ready");
    }

    // Failures
    let failures: string;
    if (!acc.enabled) {
      failures = c.dim("—");
    } else if (acc.consecutiveFailures > 0) {
      failures = c.yellow(String(acc.consecutiveFailures));
    } else {
      failures = c.dim("0");
    }

    // Rate limit
    let rateLimit: string;
    if (!acc.enabled) {
      rateLimit = c.dim("—");
    } else {
      const resetTimes = acc.rateLimitResetTimes || {};
      const maxReset = Math.max(0, ...Object.values(resetTimes));
      if (maxReset > now) {
        rateLimit = c.yellow(`\u26A0 ${formatDuration(maxReset - now)}`);
      } else {
        rateLimit = c.dim("—");
      }
    }

    // Render account header line
    log.message("  " + pad(c.bold(num), 5) + pad(label, 22) + pad(status, 14) + pad(failures, 11) + rateLimit);

    // Render usage quota lines for enabled accounts
    if (acc.enabled) {
      const result = usageResults[i];
      const usage = result.status === "fulfilled" ? result.value.usage : null;
      if (usage) {
        const lines = renderUsageLines(usage);
        for (const line of lines) {
          log.message(line);
        }
      } else {
        log.message(c.dim(`${USAGE_INDENT}quotas: unavailable`));
      }
    }

    if (i < stored.accounts.length - 1) {
      log.message("");
    }
  }

  log.message("");

  const enabled = stored.accounts.filter((a) => a.enabled).length;
  const disabled = stored.accounts.length - enabled;

  const parts = [
    `Strategy: ${c.cyan(config.account_selection_strategy)}`,
    `${c.bold(String(enabled))} of ${stored.accounts.length} enabled`,
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
 * @returns {Promise<number>} exit code
 */
export async function cmdStatus() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log("anthropic: no accounts configured");
    return 1;
  }

  const config = loadConfig();
  const total = stored.accounts.length;
  const enabled = stored.accounts.filter((a) => a.enabled).length;
  const now = Date.now();

  // Count rate-limited accounts
  let rateLimited = 0;
  for (const acc of stored.accounts) {
    if (!acc.enabled) continue;
    const resetTimes = acc.rateLimitResetTimes || {};
    const maxReset = Math.max(0, ...Object.values(resetTimes));
    if (maxReset > now) rateLimited++;
  }

  let line = `anthropic: ${total} account${total !== 1 ? "s" : ""} (${enabled} active)`;
  line += `, strategy: ${config.account_selection_strategy}`;
  line += `, next: #${stored.activeIndex + 1}`;
  if (rateLimited > 0) {
    line += `, ${rateLimited} rate-limited`;
  }

  console.log(line);
  return 0;
}

/**
 * Switch active account.
 * @param {string} arg
 * @returns {Promise<number>} exit code
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
 * @param {string} arg
 * @returns {Promise<number>} exit code
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
 * @param {string} arg
 * @returns {Promise<number>} exit code
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

  // Don't allow disabling the last enabled account
  const enabledCount = stored.accounts.filter((a) => a.enabled).length;
  if (enabledCount <= 1) {
    log.error("Error: cannot disable the last enabled account.");
    return 1;
  }

  stored.accounts[idx].enabled = false;

  const label = stored.accounts[idx].email || `Account ${n}`;
  let switchedTo = null;

  // If we disabled the active account, switch to the next enabled one
  // (adjust before saving to avoid a TOCTOU race with the running plugin)
  if (idx === stored.activeIndex) {
    const nextEnabled = stored.accounts.findIndex((a) => a.enabled);
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
 * Remove an account permanently.
 * @param {string} arg
 * @param {object} [opts]
 * @param {boolean} [opts.force] Skip confirmation prompt
 * @returns {Promise<number>} exit code
 */
export async function cmdRemove(arg?: string, opts: { force?: boolean } = {}) {
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

  const label = stored.accounts[idx].email || `Account ${n}`;

  // Confirm unless --force
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

  // Adjust active index
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
 * Reset rate-limit and failure tracking.
 * @param {string} arg - Account number or "all"
 * @returns {Promise<number>} exit code
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
    for (const acc of stored.accounts) {
      acc.rateLimitResetTimes = {};
      acc.consecutiveFailures = 0;
      acc.lastFailureTime = null;
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
 * Show current configuration.
 * @returns {Promise<number>} exit code
 */
export async function cmdConfig() {
  const config = loadConfig();
  const stored = await loadAccounts();

  log.info(c.bold("Anthropic Auth Configuration"));

  const generalLines = [
    `Strategy:          ${c.cyan(config.account_selection_strategy)}`,
    `Failure TTL:       ${config.failure_ttl_seconds}s`,
    `Debug:             ${config.debug ? c.yellow("on") : "off"}`,
  ];
  note(generalLines.join("\n"), "General");

  const healthLines = [
    `Initial:         ${config.health_score.initial}`,
    `Success reward:  +${config.health_score.success_reward}`,
    `Rate limit:      ${config.health_score.rate_limit_penalty}`,
    `Failure:         ${config.health_score.failure_penalty}`,
    `Recovery/hour:   +${config.health_score.recovery_rate_per_hour}`,
    `Min usable:      ${config.health_score.min_usable}`,
  ];
  note(healthLines.join("\n"), "Health Score");

  const bucketLines = [
    `Max tokens:      ${config.token_bucket.max_tokens}`,
    `Regen/min:       ${config.token_bucket.regeneration_rate_per_minute}`,
    `Initial:         ${config.token_bucket.initial_tokens}`,
  ];
  note(bucketLines.join("\n"), "Token Bucket");

  const fileLines = [
    `Config:          ${shortPath(getConfigPath())}`,
    `Accounts:        ${shortPath(getStoragePath())}`,
  ];
  if (stored) {
    const enabled = stored.accounts.filter((a) => a.enabled).length;
    fileLines.push(`Accounts total:  ${stored.accounts.length} (${enabled} enabled)`);
  } else {
    fileLines.push(`Accounts total:  none`);
  }
  note(fileLines.join("\n"), "Files");

  const envOverrides: string[] = [];
  if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    envOverrides.push(`OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY}`);
  }
  if (process.env.OPENCODE_ANTHROPIC_DEBUG) {
    envOverrides.push(`OPENCODE_ANTHROPIC_DEBUG=${process.env.OPENCODE_ANTHROPIC_DEBUG}`);
  }
  if (envOverrides.length > 0) {
    log.warn("Environment overrides:\n" + envOverrides.map((ov) => `  ${c.yellow(ov)}`).join("\n"));
  }

  return 0;
}

/**
 * Show or change the account selection strategy.
 * @param {string} [arg] - New strategy name, or undefined to show current
 * @returns {Promise<number>} exit code
 */
export async function cmdStrategy(arg?: string) {
  const config = loadConfig();

  if (!arg) {
    log.info(c.bold("Account Selection Strategy"));

    const descriptions = {
      sticky: "Stay on one account until it fails or is rate-limited",
      "round-robin": "Rotate through accounts on every request",
      hybrid: "Prefer healthy accounts, rotate when degraded",
    };

    const lines = VALID_STRATEGIES.map((s) => {
      const current = s === config.account_selection_strategy;
      const marker = current ? c.green("▸ ") : "  ";
      const name = current ? c.bold(c.cyan(s)) : c.dim(s);
      const desc = current ? descriptions[s] : c.dim(descriptions[s]);
      return `${marker}${pad(name, 16)}${desc}`;
    });
    log.message(lines.join("\n"));

    log.message(c.dim(`Change with: opencode-anthropic-auth strategy <${VALID_STRATEGIES.join("|")}>`));

    if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
      log.warn(
        `OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} overrides config file at runtime.`,
      );
    }

    return 0;
  }

  const normalized = arg.toLowerCase().trim();

  if (!VALID_STRATEGIES.includes(normalized as any)) {
    log.error(`Invalid strategy '${arg}'. Valid strategies: ${VALID_STRATEGIES.join(", ")}`);
    return 1;
  }

  if (normalized === config.account_selection_strategy && !process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    log.message(c.dim(`Strategy is already '${normalized}'.`));
    return 0;
  }

  saveConfig({ account_selection_strategy: normalized });
  log.success(`Strategy changed to '${normalized}'.`);

  if (process.env.OPENCODE_ANTHROPIC_STRATEGY) {
    log.warn(`OPENCODE_ANTHROPIC_STRATEGY=${process.env.OPENCODE_ANTHROPIC_STRATEGY} will override this at runtime.`);
  }

  return 0;
}

/**
 * Format a token count for display. Uses K/M suffixes for readability.
 * @param {number} n
 * @returns {string}
 */
function fmtTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/**
 * Show per-account usage statistics.
 * @returns {Promise<number>} exit code
 */
export async function cmdStats() {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    log.warn("No accounts configured.");
    return 1;
  }

  // Column widths: marker(1) + gap(1) + num(2) + gap(2) + name(20) + gap(2) + 5 numeric cols(10 each)
  const W = { num: 4, name: 22, val: 10 };

  const RULE = c.dim("  " + "─".repeat(74));

  log.message(c.bold("Anthropic Account Usage"));
  log.message(
    "  " +
      pad(c.dim("#"), W.num) +
      pad(c.dim("Account"), W.name) +
      rpad(c.dim("Requests"), W.val) +
      rpad(c.dim("Input"), W.val) +
      rpad(c.dim("Output"), W.val) +
      rpad(c.dim("Cache R"), W.val) +
      rpad(c.dim("Cache W"), W.val),
  );
  log.message(RULE);

  let totReq = 0,
    totIn = 0,
    totOut = 0,
    totCR = 0,
    totCW = 0;
  let oldestReset = Infinity;

  for (let i = 0; i < stored.accounts.length; i++) {
    const acc = stored.accounts[i];
    const s = acc.stats || createDefaultStats();
    const isActive = i === stored.activeIndex;
    const marker = isActive ? c.green("●") : " ";
    const num = `${marker} ${i + 1}`;
    const name = acc.email || `Account ${i + 1}`;

    log.message(
      "  " +
        pad(num, W.num) +
        pad(name, W.name) +
        rpad(String(s.requests), W.val) +
        rpad(fmtTokens(s.inputTokens), W.val) +
        rpad(fmtTokens(s.outputTokens), W.val) +
        rpad(fmtTokens(s.cacheReadTokens), W.val) +
        rpad(fmtTokens(s.cacheWriteTokens), W.val),
    );

    totReq += s.requests;
    totIn += s.inputTokens;
    totOut += s.outputTokens;
    totCR += s.cacheReadTokens;
    totCW += s.cacheWriteTokens;
    if (s.lastReset < oldestReset) oldestReset = s.lastReset;
  }

  if (stored.accounts.length > 1) {
    log.message(RULE);
    log.message(
      c.bold(
        "  " +
          pad("", W.num) +
          pad("Total", W.name) +
          rpad(String(totReq), W.val) +
          rpad(fmtTokens(totIn), W.val) +
          rpad(fmtTokens(totOut), W.val) +
          rpad(fmtTokens(totCR), W.val) +
          rpad(fmtTokens(totCW), W.val),
      ),
    );
  }

  if (oldestReset < Infinity) {
    log.message(c.dim(`Tracking since: ${new Date(oldestReset).toLocaleString()} (${formatTimeAgo(oldestReset)})`));
  }

  return 0;
}

/**
 * Reset usage statistics for one or all accounts.
 * @param {string} [arg] - Account number or "all"
 * @returns {Promise<number>} exit code
 */
export async function cmdResetStats(arg?: string) {
  const stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    log.warn("No accounts configured.");
    return 1;
  }

  const now = Date.now();

  if (!arg || arg === "all") {
    for (const acc of stored.accounts) {
      acc.stats = createDefaultStats(now);
    }
    await saveAccounts(stored);
    log.success("Reset usage statistics for all accounts.");
    return 0;
  }

  const idx = parseInt(arg, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= stored.accounts.length) {
    log.error(`Invalid account number. Use 1-${stored.accounts.length} or 'all'.`);
    return 1;
  }

  stored.accounts[idx].stats = createDefaultStats(now);
  await saveAccounts(stored);
  const name = stored.accounts[idx].email || `Account ${idx + 1}`;
  log.success(`Reset usage statistics for ${name}.`);
  return 0;
}

/**
 * Interactive account management menu.
 *
 * Operates on raw storage (not AccountManager) to avoid stale-state issues.
 * Each mutation is saved atomically before the next prompt.
 *
 * @returns {Promise<number>} exit code
 */
export async function cmdManage() {
  let stored = await loadAccounts();
  if (!stored || stored.accounts.length === 0) {
    console.log(c.yellow("No accounts configured."));
    console.log(c.dim("Run 'opencode auth login' and select 'Claude Pro/Max' to add accounts."));
    return 1;
  }

  if (!process.stdin.isTTY) {
    console.error(c.red("Error: 'manage' requires an interactive terminal."));
    console.error(c.dim("Use 'enable', 'disable', 'remove', 'switch' for non-interactive use."));
    return 1;
  }

  while (true) {
    // Re-read from disk each iteration to stay in sync
    stored = await loadAccounts();
    if (!stored || stored.accounts.length === 0) {
      console.log(c.dim("No accounts remaining."));
      break;
    }

    const accounts = stored.accounts;
    const activeIndex = stored.activeIndex;
    const currentStrategy = loadConfig().account_selection_strategy;

    console.log("");
    console.log(c.bold(`${accounts.length} account(s):`));
    for (let i = 0; i < accounts.length; i++) {
      const num = i + 1;
      const label = accounts[i].email || `Account ${num}`;
      const active = i === stored.activeIndex ? c.green(" (active)") : "";
      const disabled = !accounts[i].enabled ? c.yellow(" [disabled]") : "";
      console.log(`  ${c.bold(String(num))}. ${label}${active}${disabled}`);
    }
    console.log("");
    console.log(c.dim(`Strategy: ${currentStrategy}`));

    const action = await select<"switch" | "enable" | "disable" | "remove" | "reset" | "strategy" | "quit">({
      message: "Choose an action.",
      options: [
        { value: "switch", label: "Switch", hint: "set the active account" },
        { value: "enable", label: "Enable", hint: "re-enable a disabled account" },
        { value: "disable", label: "Disable", hint: "skip an account in rotation" },
        { value: "remove", label: "Remove", hint: "delete an account from storage" },
        { value: "reset", label: "Reset", hint: "clear rate-limit and failure tracking" },
        { value: "strategy", label: "Strategy", hint: currentStrategy },
        { value: "quit", label: "Quit", hint: "exit manage" },
      ],
    });
    if (isCancel(action) || action === "quit") break;

    if (action === "strategy") {
      const strategy = await select<(typeof VALID_STRATEGIES)[number]>({
        message: "Choose an account selection strategy.",
        initialValue: currentStrategy,
        options: VALID_STRATEGIES.map((value) => ({
          value,
          label: value,
          hint: value === currentStrategy ? "current" : undefined,
        })),
      });
      if (isCancel(strategy)) break;
      saveConfig({ account_selection_strategy: strategy });
      console.log(c.green(`Strategy changed to '${strategy}'.`));
      continue;
    }

    const target = await select<string>({
      message: "Choose an account.",
      initialValue: String(activeIndex),
      options: accounts.map((account, index) => {
        const num = index + 1;
        const label = account.email || `Account ${num}`;
        const statuses = [index === activeIndex ? "active" : null, !account.enabled ? "disabled" : null].filter(
          Boolean,
        );
        return {
          value: String(index),
          label: `#${num} ${label}`,
          hint: statuses.length > 0 ? statuses.join(", ") : undefined,
        };
      }),
    });
    if (isCancel(target)) break;

    const idx = Number.parseInt(target, 10);
    const num = idx + 1;

    switch (action) {
      case "switch": {
        if (!accounts[idx].enabled) {
          console.log(c.yellow(`Account ${num} is disabled. Enable it first.`));
          break;
        }
        stored.activeIndex = idx;
        await saveAccounts(stored);
        const switchLabel = accounts[idx].email || `Account ${num}`;
        console.log(c.green(`Switched to #${num} (${switchLabel}).`));
        break;
      }
      case "enable": {
        if (accounts[idx].enabled) {
          console.log(c.dim(`Account ${num} is already enabled.`));
          break;
        }
        stored.accounts[idx].enabled = true;
        await saveAccounts(stored);
        console.log(c.green(`Enabled account #${num}.`));
        break;
      }
      case "disable": {
        if (!accounts[idx].enabled) {
          console.log(c.dim(`Account ${num} is already disabled.`));
          break;
        }
        const enabledCount = accounts.filter((account) => account.enabled).length;
        if (enabledCount <= 1) {
          console.log(c.red("Cannot disable the last enabled account."));
          break;
        }
        stored.accounts[idx].enabled = false;
        if (idx === stored.activeIndex) {
          const nextEnabled = accounts.findIndex((account, accountIndex) => accountIndex !== idx && account.enabled);
          if (nextEnabled >= 0) stored.activeIndex = nextEnabled;
        }
        await saveAccounts(stored);
        console.log(c.yellow(`Disabled account #${num}.`));
        break;
      }
      case "remove": {
        const removeLabel = accounts[idx].email || `Account ${num}`;
        const removeConfirm = await confirm({
          message: `Remove #${num} (${removeLabel})?`,
        });
        if (isCancel(removeConfirm)) break;
        if (removeConfirm) {
          stored.accounts.splice(idx, 1);
          if (stored.accounts.length === 0) {
            stored.activeIndex = 0;
          } else if (stored.activeIndex >= stored.accounts.length) {
            stored.activeIndex = stored.accounts.length - 1;
          } else if (stored.activeIndex > idx) {
            stored.activeIndex--;
          }
          await saveAccounts(stored);
          console.log(c.green(`Removed account #${num}.`));
        } else {
          console.log(c.dim("Cancelled."));
        }
        break;
      }
      case "reset": {
        stored.accounts[idx].rateLimitResetTimes = {};
        stored.accounts[idx].consecutiveFailures = 0;
        stored.accounts[idx].lastFailureTime = null;
        await saveAccounts(stored);
        console.log(c.green(`Reset tracking for account #${num}.`));
        break;
      }
    }
  }

  return 0;
}

/**
 * Show help text.
 */
export function cmdHelp() {
  const bin = "opencode-anthropic-auth";
  console.log(`
${c.bold("Anthropic Multi-Account Auth CLI")}

${c.dim("Usage:")}
  ${bin} [group] [command] [args]
  ${bin} [command] [args] ${c.dim("(legacy format, still supported)")}
  oaa [group] [command] [args] ${c.dim("(short alias)")}

${c.dim("Command Groups:")}
  ${pad(c.cyan("auth"), 22)}Authentication: login, logout, reauth, refresh
  ${pad(c.cyan("account"), 22)}Account management: list, switch, enable, disable, remove, reset
  ${pad(c.cyan("usage"), 22)}Usage statistics: stats, reset-stats, status
  ${pad(c.cyan("config"), 22)}Configuration: show, strategy
  ${pad(c.cyan("manage"), 22)}Interactive account management menu

${c.dim("Auth Commands:")}
  ${pad(c.cyan("login"), 22)}Add a new account via browser OAuth (alias: ln)
  ${pad(c.cyan("logout") + " <N>", 22)}Revoke tokens and remove account N (alias: lo)
  ${pad(c.cyan("logout") + " --all", 22)}Revoke all tokens and clear all accounts
  ${pad(c.cyan("reauth") + " <N>", 22)}Re-authenticate account N (alias: ra)
  ${pad(c.cyan("refresh") + " <N>", 22)}Attempt token refresh (alias: rf)

${c.dim("Account Commands:")}
  ${pad(c.cyan("list"), 22)}Show all accounts with status ${c.dim("(default, alias: ls)")}
  ${pad(c.cyan("switch") + " <N>", 22)}Set account N as active (alias: sw)
  ${pad(c.cyan("enable") + " <N>", 22)}Enable a disabled account (alias: en)
  ${pad(c.cyan("disable") + " <N>", 22)}Disable an account (alias: dis)
  ${pad(c.cyan("remove") + " <N>", 22)}Remove an account permanently (alias: rm)
  ${pad(c.cyan("reset") + " <N|all>", 22)}Clear rate-limit / failure tracking

${c.dim("Usage Commands:")}
  ${pad(c.cyan("stats"), 22)}Show per-account usage statistics
  ${pad(c.cyan("reset-stats") + " [N|all]", 22)}Reset usage statistics
  ${pad(c.cyan("status"), 22)}Compact one-liner for scripts/prompts (alias: st)

${c.dim("Config Commands:")}
  ${pad(c.cyan("config"), 22)}Show configuration and file paths (alias: cfg)
  ${pad(c.cyan("strategy") + " [name]", 22)}Show or change selection strategy (alias: strat)

${c.dim("Manage Commands:")}
  ${pad(c.cyan("manage"), 22)}Interactive account management menu (alias: mg)
  ${pad(c.cyan("help"), 22)}Show this help message

${c.dim("Group Help:")}
  ${bin} auth help         ${c.dim("# Show auth commands")}
  ${bin} account help      ${c.dim("# Show account commands")}
  ${bin} usage help        ${c.dim("# Show usage commands")}
  ${bin} config help       ${c.dim("# Show config commands")}

${c.dim("Options:")}
  --force           Skip confirmation prompts
  --all             Target all accounts (for logout)
  --no-color        Disable colored output

${c.dim("Examples:")}
  ${bin} login             ${c.dim("# Add a new account via browser")}
  ${bin} auth login        ${c.dim("# Same as above (group format)")}
  oaa login             ${c.dim("# Same as above (short alias)")}
  ${bin} logout 2          ${c.dim("# Revoke tokens & remove account 2")}
  ${bin} auth logout 2     ${c.dim("# Same as above (group format)")}
  ${bin} list              ${c.dim("# Show all accounts (default)")}
  ${bin} account list      ${c.dim("# Same as above (group format)")}
  ${bin} switch 2          ${c.dim("# Make account 2 active")}
  ${bin} account switch 2  ${c.dim("# Same as above (group format)")}
  ${bin} stats             ${c.dim("# Show token usage per account")}
  ${bin} usage stats       ${c.dim("# Same as above (group format)")}

${c.dim("Files:")}
  Config:   ${shortPath(getConfigPath())}
  Accounts: ${shortPath(getStoragePath())}
`);
  return 0;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** @type {AsyncLocalStorage<{ log?: (...args: any[]) => void, error?: (...args: any[]) => void }>} */
type IoStore = {
  log?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
};
const ioContext = new AsyncLocalStorage<IoStore>();

const nativeConsoleLog = console.log.bind(console);
const nativeConsoleError = console.error.bind(console);
let consoleRouterUsers = 0;

function installConsoleRouter() {
  if (consoleRouterUsers === 0) {
    console.log = (...args) => {
      const io = ioContext.getStore();
      if (io?.log) return io.log(...args);
      return nativeConsoleLog(...args);
    };
    console.error = (...args) => {
      const io = ioContext.getStore();
      if (io?.error) return io.error(...args);
      return nativeConsoleError(...args);
    };
  }
  consoleRouterUsers++;
}

function uninstallConsoleRouter() {
  consoleRouterUsers = Math.max(0, consoleRouterUsers - 1);
  if (consoleRouterUsers === 0) {
    console.log = nativeConsoleLog;
    console.error = nativeConsoleError;
  }
}

/**
 * Run with async-local IO capture without persistent global side effects.
 * @param {{ log?: (...args: any[]) => void, error?: (...args: any[]) => void }} io
 * @param {() => Promise<number>} fn
 */
async function runWithIoContext(io: Record<string, any>, fn: () => Promise<number>) {
  installConsoleRouter();
  try {
    return await ioContext.run(io, fn);
  } finally {
    uninstallConsoleRouter();
  }
}

/**
 * Show help for a specific command group.
 * @param {string} group - The command group name
 * @returns {number} exit code
 */
function cmdGroupHelp(group: string) {
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
    case "usage":
      console.log(`
${c.bold("Usage Commands")}

  ${pad(c.cyan("stats"), 20)}Show per-account usage statistics
  ${pad(c.cyan("reset-stats") + " [N|all]", 20)}Reset usage statistics
  ${pad(c.cyan("status"), 20)}Compact one-liner for scripts/prompts (alias: st)

${c.dim("Examples:")}
  ${bin} usage stats
  ${bin} usage status
`);
      return 0;
    case "config":
      console.log(`
${c.bold("Config Commands")}

  ${pad(c.cyan("show"), 20)}Show current configuration and file paths (alias: cfg)
  ${pad(c.cyan("strategy") + " [name]", 20)}Show or change selection strategy (alias: strat)

${c.dim("Examples:")}
  ${bin} config show
  ${bin} config strategy round-robin
`);
      return 0;
    case "manage":
      console.log(`
${c.bold("Manage Command")}

  ${pad(c.cyan("manage"), 20)}Interactive account management menu (alias: mg)

${c.dim("Examples:")}
  ${bin} manage
`);
      return 0;
    default:
      console.error(c.red(`Unknown command group: ${group}`));
      return 1;
  }
}

/**
 * Dispatch auth group commands.
 * @param {string[]} args - Arguments after the group name
 * @param {{ force: boolean, all: boolean }} flags - Parsed flags
 * @returns {Promise<number>} exit code
 */
async function dispatchAuth(args: string[], flags: { force: boolean; all: boolean }) {
  const subcommand = args[0] || "help";
  const arg = args[1];

  switch (subcommand) {
    case "login":
    case "ln":
      return cmdLogin();
    case "logout":
    case "lo":
      return cmdLogout(arg, { force: flags.force, all: flags.all });
    case "reauth":
    case "ra":
      return cmdReauth(arg);
    case "refresh":
    case "rf":
      return cmdRefresh(arg);
    case "help":
    case "-h":
    case "--help":
      return cmdGroupHelp("auth");
    default:
      console.error(c.red(`Unknown auth command: ${subcommand}`));
      console.error(c.dim("Run 'opencode-anthropic-auth auth help' for usage."));
      return 1;
  }
}

/**
 * Dispatch account group commands.
 * @param {string[]} args - Arguments after the group name
 * @param {{ force: boolean }} flags - Parsed flags
 * @returns {Promise<number>} exit code
 */
async function dispatchAccount(args: string[], flags: { force: boolean }) {
  const subcommand = args[0] || "list";
  const arg = args[1];

  switch (subcommand) {
    case "list":
    case "ls":
      return cmdList();
    case "switch":
    case "sw":
      return cmdSwitch(arg);
    case "enable":
    case "en":
      return cmdEnable(arg);
    case "disable":
    case "dis":
      return cmdDisable(arg);
    case "remove":
    case "rm":
      return cmdRemove(arg, { force: flags.force });
    case "reset":
      return cmdReset(arg);
    case "help":
    case "-h":
    case "--help":
      return cmdGroupHelp("account");
    default:
      console.error(c.red(`Unknown account command: ${subcommand}`));
      console.error(c.dim("Run 'opencode-anthropic-auth account help' for usage."));
      return 1;
  }
}

/**
 * Dispatch usage group commands.
 * @param {string[]} args - Arguments after the group name
 * @returns {Promise<number>} exit code
 */
async function dispatchUsage(args: string[]) {
  const subcommand = args[0] || "stats";
  const arg = args[1];

  switch (subcommand) {
    case "stats":
      return cmdStats();
    case "reset-stats":
      return cmdResetStats(arg);
    case "status":
    case "st":
      return cmdStatus();
    case "help":
    case "-h":
    case "--help":
      return cmdGroupHelp("usage");
    default:
      console.error(c.red(`Unknown usage command: ${subcommand}`));
      console.error(c.dim("Run 'opencode-anthropic-auth usage help' for usage."));
      return 1;
  }
}

/**
 * Dispatch config group commands.
 * @param {string[]} args - Arguments after the group name
 * @returns {Promise<number>} exit code
 */
async function dispatchConfig(args: string[]) {
  const subcommand = args[0] || "show";
  const arg = args[1];

  switch (subcommand) {
    case "show":
    case "cfg":
      return cmdConfig();
    case "strategy":
    case "strat":
      return cmdStrategy(arg);
    case "help":
    case "-h":
    case "--help":
      return cmdGroupHelp("config");
    default:
      console.error(c.red(`Unknown config command: ${subcommand}`));
      console.error(c.dim("Run 'opencode-anthropic-auth config help' for usage."));
      return 1;
  }
}

/**
 * Dispatch manage group commands.
 * @param {string[]} args - Arguments after the group name
 * @returns {Promise<number>} exit code
 */
async function dispatchManage(args: string[]) {
  const subcommand = args[0] || "help";

  switch (subcommand) {
    case "manage":
    case "mg":
      return cmdManage();
    case "help":
    case "-h":
    case "--help":
      return cmdGroupHelp("manage");
    default:
      console.error(c.red(`Unknown manage command: ${subcommand}`));
      console.error(c.dim("Run 'opencode-anthropic-auth manage help' for usage."));
      return 1;
  }
}

/**
 * Parse argv and route to the appropriate command.
 * Supports two-level dispatch: group → subcommand
 * Maintains backward compatibility with legacy flat commands.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<number>} exit code
 */
async function dispatch(argv: string[]) {
  const args = argv.filter((a: string) => !a.startsWith("--"));
  const flags = argv.filter((a: string) => a.startsWith("--"));

  // Handle global flags
  if (flags.includes("--no-color")) USE_COLOR = false;
  if (flags.includes("--help")) return cmdHelp();

  const command = args[0] || "list";
  const remainingArgs = args.slice(1);

  const force = flags.includes("--force");
  const all = flags.includes("--all");

  // Two-level dispatch: check if first arg is a command group
  switch (command) {
    // Group dispatchers
    case "auth":
      return dispatchAuth(remainingArgs, { force, all });
    case "account":
      return dispatchAccount(remainingArgs, { force });
    case "usage":
      return dispatchUsage(remainingArgs);
    case "config":
      return dispatchConfig(remainingArgs);
    case "manage":
      return dispatchManage(remainingArgs);

    // Legacy backward compatibility: direct commands (map to groups)
    // Auth commands
    case "login":
    case "ln":
      return cmdLogin();
    case "logout":
    case "lo":
      return cmdLogout(remainingArgs[0], { force, all });
    case "reauth":
    case "ra":
      return cmdReauth(remainingArgs[0]);
    case "refresh":
    case "rf":
      return cmdRefresh(remainingArgs[0]);

    // Account commands
    case "list":
    case "ls":
      return cmdList();
    case "switch":
    case "sw":
      return cmdSwitch(remainingArgs[0]);
    case "enable":
    case "en":
      return cmdEnable(remainingArgs[0]);
    case "disable":
    case "dis":
      return cmdDisable(remainingArgs[0]);
    case "remove":
    case "rm":
      return cmdRemove(remainingArgs[0], { force });
    case "reset":
      return cmdReset(remainingArgs[0]);

    // Usage commands
    case "stats":
      return cmdStats();
    case "reset-stats":
      return cmdResetStats(remainingArgs[0]);
    case "status":
    case "st":
      return cmdStatus();

    // Config commands (strategy only - config/cfg handled by group dispatcher)
    case "strategy":
    case "strat":
      return cmdStrategy(remainingArgs[0]);
    case "cfg":
      // cfg alias for config - handled by group dispatcher as default
      return dispatchConfig(["show"]);

    // Manage commands
    case "mg":
      return cmdManage();

    // Help
    case "help":
    case "-h":
    case "--help":
      return cmdHelp();

    default:
      console.error(c.red(`Unknown command: ${command}`));
      console.error(c.dim("Run 'opencode-anthropic-auth help' for usage."));
      return 1;
  }
}

/**
 * Parse argv and route to the appropriate command.
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{ io?: { log?: (...args: any[]) => void, error?: (...args: any[]) => void } }} [options]
 * @returns {Promise<number>} exit code
 */
export async function main(
  argv: string[],
  options: {
    io?: { log?: (...args: any[]) => void; error?: (...args: any[]) => void };
  } = {},
) {
  if (options.io) {
    return runWithIoContext(options.io, () => dispatch(argv));
  }
  return dispatch(argv);
}

// Run if executed directly (not imported)
async function detectMain() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  // Handle symlinks (e.g., ~/.config/opencode/plugin/opencode-anthropic-auth-plugin.js → index.mjs)
  try {
    const { realpath } = await import("node:fs/promises");
    const resolved = await realpath(process.argv[1]);
    return import.meta.url === pathToFileURL(resolved).href;
  } catch {
    return false;
  }
}

if (await detectMain()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(c.red(`Fatal: ${err.message}`));
      process.exit(1);
    });
}
