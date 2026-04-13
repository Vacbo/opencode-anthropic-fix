/**
 * CLI formatting and rendering utilities.
 *
 * Pure formatting helpers for ANSI colors, durations, progress bars,
 * and terminal output formatting. Zero dependencies, respects NO_COLOR / TTY.
 */

// ---------------------------------------------------------------------------
// Color helpers — zero dependencies, respects NO_COLOR / TTY
// ---------------------------------------------------------------------------

let USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY !== false;

/** Enable or disable color output globally. */
export function setUseColor(value: boolean) {
    USE_COLOR = value;
}

/** @param {string} code @param {string} text @returns {string} */
export function ansi(code: string, text: string) {
    return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const c = {
    bold: (t: string) => ansi("1", t),
    dim: (t: string) => ansi("2", t),
    green: (t: string) => ansi("32", t),
    yellow: (t: string) => ansi("33", t),
    cyan: (t: string) => ansi("36", t),
    red: (t: string) => ansi("31", t),
    gray: (t: string) => ansi("90", t),
};

// ---------------------------------------------------------------------------
// ANSI escape code handling
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape codes from a string to get its visible content.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with \x1b which is a control char
    return str.replace(new RegExp("\x1b\\[[0-9;]*m", "g"), "");
}

// ---------------------------------------------------------------------------
// Duration and time formatting
// ---------------------------------------------------------------------------

/**
 * Format milliseconds as a human-readable duration.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms: number): string {
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
export function formatTimeAgo(timestamp: number | null | undefined): string {
    if (!timestamp || timestamp === 0) return "never";
    const ms = Date.now() - timestamp;
    if (ms < 0) return "just now";
    return `${formatDuration(ms)} ago`;
}

/**
 * Format an ISO 8601 reset timestamp as a relative duration from now.
 * @param {string} isoString
 * @returns {string}
 */
export function formatResetTime(isoString: string): string {
    const resetMs = new Date(isoString).getTime();
    const remaining = resetMs - Date.now();
    if (remaining <= 0) return "now";
    return formatDuration(remaining);
}

// ---------------------------------------------------------------------------
// Path formatting
// ---------------------------------------------------------------------------

/**
 * Shorten a path by replacing home directory with ~.
 * @param {string} p
 * @returns {string}
 */
export function shortPath(p: string): string {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home && p.startsWith(home)) return "~" + p.slice(home.length);
    return p;
}

// ---------------------------------------------------------------------------
// Padding and alignment helpers
// ---------------------------------------------------------------------------

/**
 * Left-pad a string to a fixed visible width, accounting for ANSI escape codes.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function pad(str: string, width: number): string {
    const diff = width - stripAnsi(str).length;
    return diff > 0 ? str + " ".repeat(diff) : str;
}

/**
 * Right-align a string to a fixed visible width, accounting for ANSI escape codes.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function rpad(str: string, width: number): string {
    const diff = width - stripAnsi(str).length;
    return diff > 0 ? " ".repeat(diff) + str : str;
}

// ---------------------------------------------------------------------------
// Progress bar rendering
// ---------------------------------------------------------------------------

/**
 * Render a progress bar of a given width for a utilization percentage (0–100).
 * @param {number} utilization - percentage (0 to 100)
 * @param {number} [width=10] - bar character width
 * @returns {string}
 */
export function renderBar(utilization: number, width = 10): string {
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

// ---------------------------------------------------------------------------
// Usage quota rendering
// ---------------------------------------------------------------------------

/**
 * Known usage quota buckets and their display labels.
 * Order determines display order.
 */
export const QUOTA_BUCKETS = [
    { key: "five_hour", label: "5h" },
    { key: "seven_day", label: "7d" },
    { key: "seven_day_sonnet", label: "Sonnet 7d" },
    { key: "seven_day_opus", label: "Opus 7d" },
    { key: "seven_day_oauth_apps", label: "OAuth Apps 7d" },
    { key: "seven_day_cowork", label: "Cowork 7d" },
];

export const USAGE_INDENT = "       ";
export const USAGE_LABEL_WIDTH = 13;

/**
 * Render usage quota lines for an account.
 * Returns an array of pre-formatted strings (one per non-null bucket).
 * @param {Record<string, any>} usage
 * @returns {string[]}
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- upstream Anthropic usage API response has unstable bucket shapes
export function renderUsageLines(usage: Record<string, any>): string[] {
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
// Token formatting
// ---------------------------------------------------------------------------

/**
 * Format a token count for display. Uses K/M suffixes for readability.
 * @param {number} n
 * @returns {string}
 */
export function fmtTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(n);
}
