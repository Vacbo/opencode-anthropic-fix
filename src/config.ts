import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SIGNATURE_PROFILE_ID, isKnownSignatureProfile } from "./profiles/index.js";

export type AccountSelectionStrategy = "sticky" | "round-robin" | "hybrid";

export interface HealthScoreConfig {
    initial: number;
    success_reward: number;
    rate_limit_penalty: number;
    failure_penalty: number;
    recovery_rate_per_hour: number;
    min_usable: number;
    max_score: number;
}

export interface TokenBucketConfig {
    max_tokens: number;
    regeneration_rate_per_minute: number;
    initial_tokens: number;
}

export interface ToastConfig {
    /** Suppress non-error toasts */
    quiet: boolean;
    /** Minimum seconds between account-switch toasts */
    debounce_seconds: number;
}

export interface OverrideModelLimitsConfig {
    /** When true, overrides model context limits for 1M-window models */
    enabled: boolean;
    /** Context window size to inject (tokens). Default: 1_000_000 */
    context: number;
    /** Max output tokens to inject. 0 = leave model default unchanged */
    output: number;
}

export interface IdleRefreshConfig {
    /** Opportunistically refresh near-expiry idle accounts */
    enabled: boolean;
    /** Refresh idle accounts within this many minutes of expiry */
    window_minutes: number;
    /** Minimum minutes between idle refresh attempts per account */
    min_interval_minutes: number;
}

export interface HeaderConfig {
    emulation_profile?: string;
    overrides?: Record<string, string>;
    disable?: string[];
    billing_header?: boolean;
}

export interface AnthropicAuthConfig {
    [key: string]: unknown;
    account_selection_strategy: AccountSelectionStrategy;
    signature_profile: string;
    relocate_third_party_prompts?: boolean;
    failure_ttl_seconds: number;
    debug: boolean;
    signature_emulation: {
        enabled: boolean;
        fetch_claude_code_version_on_startup: boolean;
        prompt_compaction: "minimal" | "off";
        sanitize_system_prompt: boolean;
    };
    override_model_limits: OverrideModelLimitsConfig;
    custom_betas: string[];
    health_score: HealthScoreConfig;
    token_bucket: TokenBucketConfig;
    toasts: ToastConfig;
    headers: HeaderConfig;
    idle_refresh: IdleRefreshConfig;
    cc_credential_reuse: {
        enabled: boolean;
        auto_detect: boolean;
        prefer_over_oauth: boolean;
    };
}

export const DEFAULT_CONFIG: AnthropicAuthConfig = {
    account_selection_strategy: "sticky",
    signature_profile: DEFAULT_SIGNATURE_PROFILE_ID,
    failure_ttl_seconds: 3600,
    debug: false,
    signature_emulation: {
        enabled: true,
        fetch_claude_code_version_on_startup: true,
        prompt_compaction: "minimal",
        sanitize_system_prompt: false,
    },
    override_model_limits: {
        enabled: true,
        context: 1_000_000,
        output: 0,
    },
    custom_betas: [],
    health_score: {
        initial: 70,
        success_reward: 1,
        rate_limit_penalty: -10,
        failure_penalty: -20,
        recovery_rate_per_hour: 2,
        min_usable: 50,
        max_score: 100,
    },
    token_bucket: {
        max_tokens: 50,
        regeneration_rate_per_minute: 6,
        initial_tokens: 50,
    },
    toasts: {
        quiet: false,
        debounce_seconds: 30,
    },
    headers: {},
    idle_refresh: {
        enabled: true,
        window_minutes: 60,
        min_interval_minutes: 30,
    },
    cc_credential_reuse: {
        enabled: true,
        auto_detect: true,
        prefer_over_oauth: true,
    },
};

export const VALID_STRATEGIES: AccountSelectionStrategy[] = ["sticky", "round-robin", "hybrid"];

/** OpenCode's OAuth client ID for Anthropic console auth flows. */
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function createDefaultConfig(): AnthropicAuthConfig {
    return {
        ...DEFAULT_CONFIG,
        signature_emulation: { ...DEFAULT_CONFIG.signature_emulation },
        override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
        custom_betas: [...DEFAULT_CONFIG.custom_betas],
        health_score: { ...DEFAULT_CONFIG.health_score },
        token_bucket: { ...DEFAULT_CONFIG.token_bucket },
        toasts: { ...DEFAULT_CONFIG.toasts },
        headers: {},
        idle_refresh: { ...DEFAULT_CONFIG.idle_refresh },
        cc_credential_reuse: { ...DEFAULT_CONFIG.cc_credential_reuse },
    };
}

/**
 * Get the OpenCode config directory (XDG-compliant).
 */
export function getConfigDir(): string {
    const platform = process.platform;
    if (platform === "win32") {
        return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
    }
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfig, "opencode");
}

/**
 * Get the path to the config file.
 */
export function getConfigPath(): string {
    return join(getConfigDir(), "anthropic-auth.json");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function validateConfig(raw: Record<string, unknown>): AnthropicAuthConfig {
    const config = createDefaultConfig();

    if (
        typeof raw.account_selection_strategy === "string" &&
        VALID_STRATEGIES.includes(raw.account_selection_strategy as AccountSelectionStrategy)
    ) {
        config.account_selection_strategy = raw.account_selection_strategy as AccountSelectionStrategy;
    }

    if (typeof raw.signature_profile === "string" && isKnownSignatureProfile(raw.signature_profile)) {
        config.signature_profile = raw.signature_profile;
    }

    config.failure_ttl_seconds = clampNumber(raw.failure_ttl_seconds, 60, 7200, DEFAULT_CONFIG.failure_ttl_seconds);

    if (typeof raw.debug === "boolean") {
        config.debug = raw.debug;
    }

    if (raw.signature_emulation && typeof raw.signature_emulation === "object") {
        const se = raw.signature_emulation as Record<string, unknown>;
        config.signature_emulation = {
            enabled: typeof se.enabled === "boolean" ? se.enabled : DEFAULT_CONFIG.signature_emulation.enabled,
            fetch_claude_code_version_on_startup:
                typeof se.fetch_claude_code_version_on_startup === "boolean"
                    ? se.fetch_claude_code_version_on_startup
                    : DEFAULT_CONFIG.signature_emulation.fetch_claude_code_version_on_startup,
            prompt_compaction:
                se.prompt_compaction === "off" || se.prompt_compaction === "minimal"
                    ? se.prompt_compaction
                    : DEFAULT_CONFIG.signature_emulation.prompt_compaction,
            sanitize_system_prompt:
                typeof se.sanitize_system_prompt === "boolean"
                    ? se.sanitize_system_prompt
                    : DEFAULT_CONFIG.signature_emulation.sanitize_system_prompt,
        };
    }

    // Top-level alias: `sanitize_system_prompt` is honored as a convenience so
    // users can flip it on/off without learning the nested signature_emulation
    // schema. The top-level value, when set, takes precedence over the nested
    // one because it's the more specific user intent.
    if (typeof raw.sanitize_system_prompt === "boolean") {
        config.signature_emulation.sanitize_system_prompt = raw.sanitize_system_prompt;
    }

    if (raw.override_model_limits && typeof raw.override_model_limits === "object") {
        const oml = raw.override_model_limits as Record<string, unknown>;
        config.override_model_limits = {
            enabled: typeof oml.enabled === "boolean" ? oml.enabled : DEFAULT_CONFIG.override_model_limits.enabled,
            context: clampNumber(oml.context, 200_000, 2_000_000, DEFAULT_CONFIG.override_model_limits.context),
            output: clampNumber(oml.output, 0, 128_000, DEFAULT_CONFIG.override_model_limits.output),
        };
    }

    if (Array.isArray(raw.custom_betas)) {
        config.custom_betas = (raw.custom_betas as unknown[])
            .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
            .map((b) => b.trim());
    }

    if (raw.health_score && typeof raw.health_score === "object") {
        const hs = raw.health_score as Record<string, unknown>;
        config.health_score = {
            initial: clampNumber(hs.initial, 0, 100, DEFAULT_CONFIG.health_score.initial),
            success_reward: clampNumber(hs.success_reward, 0, 10, DEFAULT_CONFIG.health_score.success_reward),
            rate_limit_penalty: clampNumber(
                hs.rate_limit_penalty,
                -50,
                0,
                DEFAULT_CONFIG.health_score.rate_limit_penalty,
            ),
            failure_penalty: clampNumber(hs.failure_penalty, -100, 0, DEFAULT_CONFIG.health_score.failure_penalty),
            recovery_rate_per_hour: clampNumber(
                hs.recovery_rate_per_hour,
                0,
                20,
                DEFAULT_CONFIG.health_score.recovery_rate_per_hour,
            ),
            min_usable: clampNumber(hs.min_usable, 0, 100, DEFAULT_CONFIG.health_score.min_usable),
            max_score: clampNumber(hs.max_score, 50, 100, DEFAULT_CONFIG.health_score.max_score),
        };
    }

    if (raw.toasts && typeof raw.toasts === "object") {
        const t = raw.toasts as Record<string, unknown>;
        config.toasts = {
            quiet: typeof t.quiet === "boolean" ? t.quiet : DEFAULT_CONFIG.toasts.quiet,
            debounce_seconds: clampNumber(t.debounce_seconds, 0, 300, DEFAULT_CONFIG.toasts.debounce_seconds),
        };
    }

    if (raw.token_bucket && typeof raw.token_bucket === "object") {
        const tb = raw.token_bucket as Record<string, unknown>;
        config.token_bucket = {
            max_tokens: clampNumber(tb.max_tokens, 1, 1000, DEFAULT_CONFIG.token_bucket.max_tokens),
            regeneration_rate_per_minute: clampNumber(
                tb.regeneration_rate_per_minute,
                0.1,
                60,
                DEFAULT_CONFIG.token_bucket.regeneration_rate_per_minute,
            ),
            initial_tokens: clampNumber(tb.initial_tokens, 1, 1000, DEFAULT_CONFIG.token_bucket.initial_tokens),
        };
    }

    if (raw.headers && typeof raw.headers === "object") {
        const h = raw.headers as Record<string, unknown>;

        if (typeof h.emulation_profile === "string" && h.emulation_profile.trim()) {
            config.headers.emulation_profile = h.emulation_profile.trim();
        }

        if (h.overrides && typeof h.overrides === "object" && !Array.isArray(h.overrides)) {
            const overrides: Record<string, string> = {};
            for (const [key, value] of Object.entries(h.overrides as Record<string, unknown>)) {
                if (!key) continue;
                if (typeof value === "string") {
                    overrides[key] = value;
                }
            }
            config.headers.overrides = overrides;
        }

        if (Array.isArray(h.disable)) {
            config.headers.disable = (h.disable as unknown[])
                .filter((v): v is string => typeof v === "string")
                .map((v) => v.trim().toLowerCase())
                .filter(Boolean);
        }

        if (typeof h.billing_header === "boolean") {
            config.headers.billing_header = h.billing_header;
        }
    }

    if (raw.idle_refresh && typeof raw.idle_refresh === "object") {
        const ir = raw.idle_refresh as Record<string, unknown>;
        config.idle_refresh = {
            enabled: typeof ir.enabled === "boolean" ? ir.enabled : DEFAULT_CONFIG.idle_refresh.enabled,
            window_minutes: clampNumber(ir.window_minutes, 1, 24 * 60, DEFAULT_CONFIG.idle_refresh.window_minutes),
            min_interval_minutes: clampNumber(
                ir.min_interval_minutes,
                1,
                24 * 60,
                DEFAULT_CONFIG.idle_refresh.min_interval_minutes,
            ),
        };
    }

    if (raw.cc_credential_reuse && typeof raw.cc_credential_reuse === "object") {
        const ccr = raw.cc_credential_reuse as Record<string, unknown>;
        config.cc_credential_reuse = {
            enabled: typeof ccr.enabled === "boolean" ? ccr.enabled : DEFAULT_CONFIG.cc_credential_reuse.enabled,
            auto_detect:
                typeof ccr.auto_detect === "boolean" ? ccr.auto_detect : DEFAULT_CONFIG.cc_credential_reuse.auto_detect,
            prefer_over_oauth:
                typeof ccr.prefer_over_oauth === "boolean"
                    ? ccr.prefer_over_oauth
                    : DEFAULT_CONFIG.cc_credential_reuse.prefer_over_oauth,
        };
    }

    return config;
}

function applyEnvOverrides(config: AnthropicAuthConfig): AnthropicAuthConfig {
    const env = process.env;

    if (
        env.OPENCODE_ANTHROPIC_STRATEGY &&
        VALID_STRATEGIES.includes(env.OPENCODE_ANTHROPIC_STRATEGY as AccountSelectionStrategy)
    ) {
        config.account_selection_strategy = env.OPENCODE_ANTHROPIC_STRATEGY as AccountSelectionStrategy;
    }

    if (env.OPENCODE_ANTHROPIC_DEBUG === "1" || env.OPENCODE_ANTHROPIC_DEBUG === "true") {
        config.debug = true;
    }
    if (env.OPENCODE_ANTHROPIC_DEBUG === "0" || env.OPENCODE_ANTHROPIC_DEBUG === "false") {
        config.debug = false;
    }

    if (env.OPENCODE_ANTHROPIC_QUIET === "1" || env.OPENCODE_ANTHROPIC_QUIET === "true") {
        config.toasts.quiet = true;
    }
    if (env.OPENCODE_ANTHROPIC_QUIET === "0" || env.OPENCODE_ANTHROPIC_QUIET === "false") {
        config.toasts.quiet = false;
    }

    if (
        env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "1" ||
        env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "true"
    ) {
        config.signature_emulation.enabled = true;
    }
    if (
        env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "0" ||
        env.OPENCODE_ANTHROPIC_EMULATE_CLAUDE_CODE_SIGNATURE === "false"
    ) {
        config.signature_emulation.enabled = false;
    }

    if (
        env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "1" ||
        env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "true"
    ) {
        config.signature_emulation.fetch_claude_code_version_on_startup = true;
    }
    if (
        env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "0" ||
        env.OPENCODE_ANTHROPIC_FETCH_CLAUDE_CODE_VERSION === "false"
    ) {
        config.signature_emulation.fetch_claude_code_version_on_startup = false;
    }

    if (env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION === "off") {
        config.signature_emulation.prompt_compaction = "off";
    }
    if (env.OPENCODE_ANTHROPIC_PROMPT_COMPACTION === "minimal") {
        config.signature_emulation.prompt_compaction = "minimal";
    }

    if (
        env.OPENCODE_ANTHROPIC_SANITIZE_SYSTEM_PROMPT === "1" ||
        env.OPENCODE_ANTHROPIC_SANITIZE_SYSTEM_PROMPT === "true"
    ) {
        config.signature_emulation.sanitize_system_prompt = true;
    }
    if (
        env.OPENCODE_ANTHROPIC_SANITIZE_SYSTEM_PROMPT === "0" ||
        env.OPENCODE_ANTHROPIC_SANITIZE_SYSTEM_PROMPT === "false"
    ) {
        config.signature_emulation.sanitize_system_prompt = false;
    }

    if (
        env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "1" ||
        env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "true"
    ) {
        config.override_model_limits.enabled = true;
    }
    if (
        env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "0" ||
        env.OPENCODE_ANTHROPIC_OVERRIDE_MODEL_LIMITS === "false"
    ) {
        config.override_model_limits.enabled = false;
    }

    if (env.OPENCODE_ANTHROPIC_CC_REUSE_ENABLED === "0" || env.OPENCODE_ANTHROPIC_CC_REUSE_ENABLED === "false") {
        config.cc_credential_reuse.enabled = false;
        config.cc_credential_reuse.auto_detect = false;
    }

    return config;
}

function logConfigReadFailure(path: string, error: unknown): void {
    const err = error as NodeJS.ErrnoException;
    const code = err.code ? ` [${err.code}]` : "";
    // eslint-disable-next-line no-console -- operator diagnostic: surface config-read failure that falls back to defaults
    console.warn(`[opencode-anthropic-auth] failed to read config at ${path}${code}: ${err.message}`);
}

// Returns [result, readOK]. readOK=false means the file existed but reading or
// parsing failed; callers that need to avoid clobbering a corrupt file on save
// must check readOK before merging updates.
function readRawConfig(configPath: string): { data: Record<string, unknown> | null; readOK: boolean } {
    if (!existsSync(configPath)) return { data: null, readOK: true };

    let content: string;
    try {
        content = readFileSync(configPath, "utf-8");
    } catch (error) {
        logConfigReadFailure(configPath, error);
        return { data: null, readOK: false };
    }

    try {
        const raw = JSON.parse(content);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return { data: null, readOK: false };
        }
        return { data: raw as Record<string, unknown>, readOK: true };
    } catch (error) {
        logConfigReadFailure(configPath, error);
        return { data: null, readOK: false };
    }
}

/**
 * Load config from disk, validate, apply env overrides.
 */
export function loadConfig(): AnthropicAuthConfig {
    const configPath = getConfigPath();
    const { data } = readRawConfig(configPath);

    if (data === null) {
        return applyEnvOverrides(createDefaultConfig());
    }

    try {
        const config = validateConfig(data);
        return applyEnvOverrides(config);
    } catch (error) {
        logConfigReadFailure(configPath, error);
        return applyEnvOverrides(createDefaultConfig());
    }
}

/**
 * Load the raw config JSON from disk (without validation or env overrides).
 * Returns an empty object if the file doesn't exist or is invalid.
 */
export function loadRawConfig(): Record<string, unknown> {
    const configPath = getConfigPath();
    const { data } = readRawConfig(configPath);
    return data ?? {};
}

function deepMergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof result[key] === "object" &&
            result[key] &&
            !Array.isArray(result[key])
        ) {
            result[key] = {
                ...(result[key] as Record<string, unknown>),
                ...(value as Record<string, unknown>),
            };
        } else {
            result[key] = value;
        }
    }
    return result;
}

export class ConfigCorruptReadError extends Error {
    constructor(path: string) {
        super(
            `Refusing to overwrite ${path}: existing file is unreadable or corrupt. Fix or delete the file before updating config.`,
        );
        this.name = "ConfigCorruptReadError";
    }
}

/**
 * Save a partial config update to disk (read-modify-write).
 * Only writes the keys you provide; other keys are preserved.
 * Uses atomic write (temp + rename) for safety.
 * Throws ConfigCorruptReadError if the existing file exists but cannot be
 * parsed, rather than silently overwriting it with only the update payload.
 */
export function saveConfig(updates: Record<string, unknown>): void {
    const configPath = getConfigPath();
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });

    const { data: existing, readOK } = readRawConfig(configPath);
    if (!readOK) {
        throw new ConfigCorruptReadError(configPath);
    }

    const merged = deepMergeConfig(existing ?? {}, updates);

    const tmpPath = configPath + `.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
    });
    renameSync(tmpPath, configPath);
}

/**
 * Load config fresh from disk (bypassing any startup cache).
 */
export function loadConfigFresh(): AnthropicAuthConfig {
    return loadConfig();
}
