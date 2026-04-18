import { isTruthyEnv } from "./env.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
    readonly [key: string]: unknown;
}

const BEARER_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{10,}/g;
const OPENCODE_ANTHROPIC_DEBUG = "OPENCODE_ANTHROPIC_DEBUG";
const REDACTED_TOKEN_KEYS = new Set([
    "access",
    "access_token",
    "accessToken",
    "authorization",
    "bearer",
    "refresh",
    "refresh_token",
    "refreshToken",
    "token",
]);

export function isDebugEnabled(): boolean {
    return isTruthyEnv(process.env[OPENCODE_ANTHROPIC_DEBUG]);
}

export function redact(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return value.replace(BEARER_TOKEN_RE, "<redacted-bearer>");
    if (typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(redact);
    if (value instanceof Error) {
        return {
            name: value.name,
            message: redact(value.message),
            stack:
                typeof value.stack === "string" ? value.stack.replace(BEARER_TOKEN_RE, "<redacted-bearer>") : undefined,
        };
    }
    const entries: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        entries[k] = REDACTED_TOKEN_KEYS.has(k) && v !== undefined ? "<redacted>" : redact(v);
    }
    return entries;
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
    const payload: Record<string, unknown> = {
        level,
        scope,
        message,
        timestamp: new Date().toISOString(),
    };
    if (fields) {
        const redactedFields = redact(fields as Record<string, unknown>) as Record<string, unknown>;
        for (const [k, v] of Object.entries(redactedFields)) {
            payload[k] = v;
        }
    }
    const line = JSON.stringify(payload);
    if (level === "error" || level === "warn") {
        // eslint-disable-next-line no-console -- structured logger emits to stderr by design
        console.error(line);
    } else {
        // eslint-disable-next-line no-console -- structured logger emits to stdout by design
        console.log(line);
    }
}

export interface ScopedLogger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export function createLogger(scope: string): ScopedLogger {
    return {
        debug(message, fields) {
            if (!isDebugEnabled()) return;
            emit("debug", scope, message, fields);
        },
        info(message, fields) {
            if (!isDebugEnabled()) return;
            emit("info", scope, message, fields);
        },
        warn(message, fields) {
            emit("warn", scope, message, fields);
        },
        error(message, fields) {
            emit("error", scope, message, fields);
        },
    };
}
