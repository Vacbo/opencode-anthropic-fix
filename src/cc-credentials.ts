import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CCCredential {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
    source: "cc-keychain" | "cc-file";
    label: string;
}

type CCCredentialSource = CCCredential["source"];

interface CredentialParseMeta {
    source: CCCredentialSource;
    label: string;
}

interface SecurityCommandError {
    status?: number | null;
    code?: string;
    signal?: string | null;
    message?: string;
}

const SECURITY_TIMEOUT_MS = 5000;
const SECURITY_HANDLED_EXIT_CODES = new Set([36, 44, 128]);

function redactCommand(command: string): string {
    const firstArg = command.split(/\s+/, 2)[0] ?? command;
    return firstArg;
}

function logSecurityCommandFailure(command: string, reason: string): void {
    if (process.env.OPENCODE_ANTHROPIC_DEBUG === "1") {
        // eslint-disable-next-line no-console -- operator diagnostic: CC keychain lookup failure gated on debug flag
        console.warn(`[opencode-anthropic-auth] keychain lookup failed (${redactCommand(command)}): ${reason}`);
    }
}
const CLAUDE_CODE_SERVICE_PATTERN = /"svce"<blob>="(Claude Code-credentials[^"]*)"/g;
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCredentialShape(value: unknown): value is {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
} {
    if (!isRecord(value)) return false;
    if (typeof value.accessToken !== "string" || value.accessToken.length === 0) return false;
    if (typeof value.refreshToken !== "string" || value.refreshToken.length === 0) return false;
    if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return false;
    if (value.subscriptionType !== undefined && typeof value.subscriptionType !== "string") return false;
    return true;
}

function parseCCCredentialWithMeta(raw: string, meta: CredentialParseMeta): CCCredential | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return null;

        const wrapped = parsed.claudeAiOauth;
        const candidate = isValidCredentialShape(wrapped)
            ? wrapped
            : isValidCredentialShape(parsed)
              ? parsed
              : null;

        if (!candidate) return null;

        return {
            accessToken: candidate.accessToken,
            refreshToken: candidate.refreshToken,
            expiresAt: candidate.expiresAt,
            subscriptionType: candidate.subscriptionType,
            source: meta.source,
            label: meta.label,
        };
    } catch {
        return null;
    }
}

function extractClaudeCodeServices(raw: string): string[] {
    const services = new Set<string>();

    for (const match of raw.matchAll(CLAUDE_CODE_SERVICE_PATTERN)) {
        const service = match[1]?.trim();
        if (service) services.add(service);
    }

    return Array.from(services);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runSecurityCommand(command: string): string | null {
    try {
        return execSync(command, {
            encoding: "utf-8",
            timeout: SECURITY_TIMEOUT_MS,
        });
    } catch (error) {
        const securityError = error as SecurityCommandError;
        if (typeof securityError.status === "number" && SECURITY_HANDLED_EXIT_CODES.has(securityError.status)) {
            logSecurityCommandFailure(command, `handled exit code ${securityError.status}`);
            return null;
        }
        if (securityError.code === "ETIMEDOUT" || securityError.signal === "SIGTERM") {
            logSecurityCommandFailure(command, `timed out after ${SECURITY_TIMEOUT_MS}ms`);
            return null;
        }
        const status = typeof securityError.status === "number" ? `status ${securityError.status}` : "no status";
        const code = securityError.code ? `code ${securityError.code}` : "";
        const signal = securityError.signal ? `signal ${securityError.signal}` : "";
        const detail = [status, code, signal].filter(Boolean).join(", ");
        logSecurityCommandFailure(command, `unexpected error (${detail})`);
        return null;
    }
}

export function parseCCCredentialData(raw: string): CCCredential | null {
    return parseCCCredentialWithMeta(raw, {
        source: "cc-file",
        label: join(homedir(), ".claude", ".credentials.json"),
    });
}

export function readCCCredentialsFromKeychain(): CCCredential[] | null {
    if (process.platform !== "darwin") return null;

    const dumpOutput = runSecurityCommand("security dump-keychain");
    if (!dumpOutput) return null;

    const services = extractClaudeCodeServices(dumpOutput);
    if (services.length === 0) return null;

    const credentials: CCCredential[] = [];
    for (const service of services) {
        const rawCredential = runSecurityCommand(`security find-generic-password -s ${shellQuote(service)} -w`);
        if (!rawCredential) return null;
        const credential = parseCCCredentialWithMeta(rawCredential, {
            source: "cc-keychain",
            label: service,
        });
        if (credential) credentials.push(credential);
    }

    return credentials.length > 0 ? credentials : null;
}

export function readCCCredentialsFromFile(): CCCredential | null {
    const credentialsPath = join(homedir(), ".claude", ".credentials.json");

    try {
        const raw = readFileSync(credentialsPath, "utf-8");
        return parseCCCredentialWithMeta(raw, {
            source: "cc-file",
            label: credentialsPath,
        });
    } catch {
        return null;
    }
}

export function readCCCredentials(): CCCredential[] {
    const credentials: CCCredential[] = [];

    if (process.platform === "darwin") {
        const keychainCredentials = readCCCredentialsFromKeychain();
        if (keychainCredentials) credentials.push(...keychainCredentials);
    }

    const fileCredential = readCCCredentialsFromFile();
    if (fileCredential) credentials.push(fileCredential);

    return credentials;
}
