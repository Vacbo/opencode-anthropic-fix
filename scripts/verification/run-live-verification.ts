#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearLine, cursorTo } from "node:readline";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { classifyRisk, validateCandidateManifest } from "../../src/fingerprint/schema.ts";
import type {
    CandidateManifest,
    FieldRisk,
    ScenarioResult,
    VerificationReport,
    VerificationScenario,
} from "../../src/fingerprint/types.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_SCENARIO_DIR = resolve(SCRIPT_DIR, "scenarios");
const DEFAULT_REPORT_DIR = resolve(REPO_ROOT, "manifests/reports/verification");
const DEFAULT_OG_COMMAND_TEMPLATE = "claude --bare --print {prompt}";
const DEFAULT_PLUGIN_COMMAND_TEMPLATE = "opencode run {prompt}";
const DEFAULT_PROXY_HOST = "127.0.0.1";

export interface ScenarioDefinition extends VerificationScenario {
    runnerMode?: "prompt" | "manual";
    requestPathContains?: string;
    notes?: string[];
}

interface ParsedArgs {
    version: string;
    scenarioIds: string[];
    candidatePath: string;
    scenarioDir: string;
    reportPath?: string;
    ogCapturePath?: string;
    pluginCapturePath?: string;
    ogCommandTemplate: string;
    pluginCommandTemplate: string;
    verifiedBy: string;
    proxyHost: string;
    proxyPort?: number;
    commandTimeoutMs: number;
    help: boolean;
}

export interface CaptureRecord {
    capturedAt: string;
    method: string;
    url: string;
    path: string;
    headers: Record<string, string>;
    bodyText: string;
    parsedBody: unknown;
}

interface CaptureProxy {
    port: number;
    captures: CaptureRecord[];
    close: () => Promise<void>;
}

interface ParsedBillingHeader {
    raw: string;
    ccVersion: string | null;
    ccEntrypoint: string | null;
    cch: string | null;
}

interface CommandResult {
    stdout: string;
    stderr: string;
}

interface ProgressLineOptions {
    current: number;
    total: number;
    label: string;
    elapsedMs: number;
}

function printUsage(): void {
    console.log(`Usage: bun scripts/verification/run-live-verification.ts --version <ver> [--scenario <id>] [--scenario <id>]

Runs OG Claude Code and the local plugin through a trusted MITM proxy, compares
their sanitized request fields, and writes a verification report JSON.

Options:
  --version <ver>                  Candidate manifest version to verify
  --scenario <id[,id2]>           Scenario ID(s). Repeat or pass comma-separated values.
                                  Default: all runnable scenarios in scripts/verification/scenarios
  --candidate <path>              Candidate manifest path
                                  Default: manifests/candidate/claude-code/<version>.json
  --scenario-dir <path>           Scenario definition directory
                                  Default: scripts/verification/scenarios
  --report <path>                 Output report path
                                  Default: manifests/reports/verification/<version>-<timestamp>.json
  --og-capture <path>             Use an existing OG capture artifact instead of spawning Claude
  --plugin-capture <path>         Use an existing plugin capture artifact instead of spawning OpenCode
  --og-command-template <cmd>     Shell template for OG Claude Code
                                  Default: ${DEFAULT_OG_COMMAND_TEMPLATE}
  --plugin-command-template <cmd> Shell template for the plugin/OpenCode flow
                                  Default: ${DEFAULT_PLUGIN_COMMAND_TEMPLATE}
  --verified-by <label>           Runner label stored in the report
                                  Default: trusted-local-verifier
  --proxy-host <host>             Proxy bind host and HTTPS proxy host
                                  Default: ${DEFAULT_PROXY_HOST}
  --proxy-port <port>             Fixed proxy port (defaults to an ephemeral port)
  --command-timeout-ms <ms>       Kill OG/plugin commands that exceed this duration
                                  Default: 120000
  --help                          Show this help message

Template placeholders:
  {prompt}                        Shell-escaped scenario prompt

Examples:
  bun scripts/verification/run-live-verification.ts --version 2.1.109 --scenario minimal-hi
  bun scripts/verification/run-live-verification.ts --version 2.1.109 --scenario minimal-hi,append-system-prompt
  bun scripts/verification/run-live-verification.ts --version 2.1.109 \
      --plugin-command-template 'opencode run {prompt}'
`);
}

export function parseArgs(args: string[]): ParsedArgs {
    let version = "";
    let candidatePath = "";
    let scenarioDir = DEFAULT_SCENARIO_DIR;
    let reportPath: string | undefined;
    let ogCapturePath: string | undefined;
    let pluginCapturePath: string | undefined;
    let ogCommandTemplate = DEFAULT_OG_COMMAND_TEMPLATE;
    let pluginCommandTemplate = DEFAULT_PLUGIN_COMMAND_TEMPLATE;
    let verifiedBy = "trusted-local-verifier";
    let proxyHost = DEFAULT_PROXY_HOST;
    let proxyPort: number | undefined;
    let commandTimeoutMs = 120_000;
    let help = false;
    const scenarioIds: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help") {
            help = true;
            continue;
        }
        if (arg === "--version" && index + 1 < args.length) {
            version = args[index + 1] ?? "";
            index += 1;
            continue;
        }
        if (arg === "--scenario" && index + 1 < args.length) {
            scenarioIds.push(...splitScenarioIds(args[index + 1] ?? ""));
            index += 1;
            continue;
        }
        if (arg === "--candidate" && index + 1 < args.length) {
            candidatePath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--scenario-dir" && index + 1 < args.length) {
            scenarioDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--report" && index + 1 < args.length) {
            reportPath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--og-capture" && index + 1 < args.length) {
            ogCapturePath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--plugin-capture" && index + 1 < args.length) {
            pluginCapturePath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--og-command-template" && index + 1 < args.length) {
            ogCommandTemplate = args[index + 1] ?? "";
            index += 1;
            continue;
        }
        if (arg === "--plugin-command-template" && index + 1 < args.length) {
            pluginCommandTemplate = args[index + 1] ?? "";
            index += 1;
            continue;
        }
        if (arg === "--verified-by" && index + 1 < args.length) {
            verifiedBy = args[index + 1] ?? "";
            index += 1;
            continue;
        }
        if (arg === "--proxy-host" && index + 1 < args.length) {
            proxyHost = (args[index + 1] ?? "").trim() || DEFAULT_PROXY_HOST;
            index += 1;
            continue;
        }
        if (arg === "--proxy-port" && index + 1 < args.length) {
            proxyPort = parsePort(args[index + 1] ?? "", "--proxy-port");
            index += 1;
            continue;
        }
        if (arg === "--command-timeout-ms" && index + 1 < args.length) {
            const timeout = Number.parseInt(args[index + 1] ?? "", 10);
            if (!Number.isInteger(timeout) || timeout <= 0) {
                throw new Error("--command-timeout-ms must be a positive integer");
            }
            commandTimeoutMs = timeout;
            index += 1;
            continue;
        }
    }

    if (!help && !version.trim()) {
        throw new Error("Missing required --version <ver>");
    }

    return {
        version: version.trim(),
        scenarioIds,
        candidatePath: candidatePath || resolve(REPO_ROOT, `manifests/candidate/claude-code/${version}.json`),
        scenarioDir,
        reportPath,
        ogCapturePath,
        pluginCapturePath,
        ogCommandTemplate,
        pluginCommandTemplate,
        verifiedBy: verifiedBy.trim() || "trusted-local-verifier",
        proxyHost,
        proxyPort,
        commandTimeoutMs,
        help,
    };
}

function splitScenarioIds(input: string): string[] {
    return input
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
}

function parsePort(value: string, flagName: string): number {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${flagName} must be a valid TCP port (1-65535)`);
    }
    return port;
}

function readJsonFile<T>(filePath: string): T {
    try {
        return JSON.parse(readFileSync(filePath, "utf8")) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read JSON from ${filePath}: ${message}`);
    }
}

export function loadScenarioDefinitions(scenarioDir: string): ScenarioDefinition[] {
    const scenarioFiles = readdirSync(scenarioDir)
        .filter((entry) => entry.endsWith(".json"))
        .sort();

    if (scenarioFiles.length === 0) {
        throw new Error(`No scenario JSON files found in ${scenarioDir}`);
    }

    return scenarioFiles.map((fileName) => {
        const scenario = readJsonFile<ScenarioDefinition>(join(scenarioDir, fileName));
        if (!scenario.id || (!scenario.prompt && scenario.runnerMode !== "manual")) {
            throw new Error(`Scenario ${fileName} is missing required fields`);
        }
        return scenario;
    });
}

function selectScenarios(allScenarios: ScenarioDefinition[], requestedIds: string[]): ScenarioDefinition[] {
    if (requestedIds.length === 0) {
        return allScenarios.filter((scenario) => scenario.runnerMode !== "manual");
    }

    const byId = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
    return requestedIds.map((id) => {
        const scenario = byId.get(id);
        if (!scenario) {
            throw new Error(`Unknown scenario: ${id}`);
        }
        return scenario;
    });
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(template: string, prompt: string): string {
    return template.split("{prompt}").join(shellQuote(prompt));
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function normalizeStoredCapture(input: unknown): CaptureRecord {
    if (!input || typeof input !== "object") {
        throw new Error("Capture artifact must be an object");
    }

    const record = input as Record<string, unknown>;
    const headersSource = record.headers && typeof record.headers === "object" ? (record.headers as Record<string, unknown>) : {};
    const headers = Object.fromEntries(
        Object.entries(headersSource)
            .filter(([, value]) => typeof value === "string")
            .map(([key, value]) => [key.toLowerCase(), value as string]),
    );
    const bodyText = typeof record.bodyText === "string" ? record.bodyText : typeof record.body === "string" ? record.body : "";
    const method = typeof record.method === "string" ? record.method : "POST";
    const path = typeof record.path === "string" ? record.path : "/";
    const url = typeof record.url === "string" ? record.url : `https://${String(record.host ?? "")}${path}`;

    return {
        capturedAt: typeof record.capturedAt === "string" ? record.capturedAt : new Date().toISOString(),
        method,
        url,
        path,
        headers,
        bodyText,
        parsedBody: parseJson(bodyText),
    };
}

function normalizeVersion(value: string | null): string | null {
    if (!value) {
        return null;
    }
    const match = value.match(/\d+\.\d+\.\d+/);
    return match?.[0] ?? value;
}

function parseAnthropicBetaHeader(value: string | undefined): {
    requiredBaseBetas: string[];
    authModeBetas: string[];
    optionalBetas: string[];
} {
    const betas = [
        ...new Set(
            (value ?? "")
                .split(",")
                .map((beta) => beta.trim())
                .filter(Boolean),
        ),
    ].sort();
    const authBetas = betas.filter((beta) => beta.startsWith("oauth-"));
    const optionalBetas = betas.filter((beta) => !beta.startsWith("oauth-"));
    return {
        requiredBaseBetas: authBetas,
        authModeBetas: authBetas,
        optionalBetas,
    };
}

function extractSystemBlocks(system: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(system)) {
        return [];
    }

    return system.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null);
}

function getSystemText(block: Record<string, unknown>): string {
    return typeof block.text === "string" ? block.text : "";
}

function parseBillingHeader(raw: string): ParsedBillingHeader {
    const ccVersion = raw.match(/cc_version=([^;]+)/)?.[1] ?? null;
    const ccEntrypoint = raw.match(/cc_entrypoint=([^;]+)/)?.[1] ?? null;
    const cch = raw.match(/cch=([0-9a-f]{5})/)?.[1] ?? null;

    return {
        raw,
        ccVersion: normalizeVersion(ccVersion),
        ccEntrypoint,
        cch,
    };
}

function summarizeMetadataShape(metadata: unknown): {
    userIdShape: string;
    deviceLinkage: string;
    accountLinkage: string;
} {
    if (!metadata || typeof metadata !== "object") {
        return {
            userIdShape: "missing",
            deviceLinkage: "missing",
            accountLinkage: "missing",
        };
    }

    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId !== "string") {
        return {
            userIdShape: "missing",
            deviceLinkage: "missing",
            accountLinkage: "missing",
        };
    }

    const parsedUserId = parseJson(userId);
    if (!parsedUserId || typeof parsedUserId !== "object") {
        return {
            userIdShape: "string",
            deviceLinkage: "unknown",
            accountLinkage: "unknown",
        };
    }

    const objectValue = parsedUserId as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort();
    return {
        userIdShape: `json:${keys.join("+")}`,
        deviceLinkage: typeof objectValue.device_id === "string" ? "metadata.user_id.device_id" : "missing",
        accountLinkage: typeof objectValue.account_uuid === "string" ? "metadata.user_id.account_uuid" : "missing",
    };
}

export function extractComparableFields(capture: CaptureRecord): Record<string, unknown> {
    const headers = capture.headers;
    const parsedBody =
        capture.parsedBody && typeof capture.parsedBody === "object"
            ? (capture.parsedBody as Record<string, unknown>)
            : {};
    const systemBlocks = extractSystemBlocks(parsedBody.system);
    const billingBlock = systemBlocks.find((block) => getSystemText(block).startsWith("x-anthropic-billing-header:"));
    const identityBlock = systemBlocks.find(
        (block) => getSystemText(block) === "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    const parsedBetas = parseAnthropicBetaHeader(headers["anthropic-beta"]);
    const parsedBilling = parseBillingHeader(getSystemText(billingBlock ?? {}));
    const metadataSummary = summarizeMetadataShape(parsedBody.metadata);
    const stainlessHeaders = Object.fromEntries(
        Object.entries(headers)
            .filter(([key]) => key.startsWith("x-stainless-"))
            .sort(([left], [right]) => left.localeCompare(right)),
    );

    return {
        "transport.pathStyle": capture.path,
        "transport.defaultHeaders": Object.fromEntries(
            ["content-type", "anthropic-version", "anthropic-dangerous-direct-browser-access"]
                .filter((headerName) => headers[headerName])
                .map((headerName) => [headerName, headers[headerName] ?? ""]),
        ),
        "transport.authHeaderMode": headers.authorization?.startsWith("Bearer ") ? "bearer" : "unknown",
        "headers.userAgent": headers["user-agent"] ?? null,
        "headers.xApp": headers["x-app"] ?? null,
        "headers.xStainlessHeaders": stainlessHeaders,
        "headers.xClientRequestId": headers["x-client-request-id"] ? "present" : "missing",
        "headers.xClaudeCodeSessionId": headers["x-claude-code-session-id"] ? "present" : "missing",
        "betas.requiredBaseBetas": parsedBetas.requiredBaseBetas,
        "betas.optionalBetas": parsedBetas.optionalBetas,
        "betas.authModeBetas": parsedBetas.authModeBetas,
        "billing.ccVersion": parsedBilling.ccVersion,
        "billing.ccEntrypoint": parsedBilling.ccEntrypoint,
        "billing.cchStrategy": parsedBilling.cch ? "xxhash64-5hex" : "missing",
        "body.defaultStream": parsedBody.stream === true,
        "body.defaultMaxTokens": typeof parsedBody.max_tokens === "number" ? parsedBody.max_tokens : null,
        "body.temperaturePresence": Object.prototype.hasOwnProperty.call(parsedBody, "temperature"),
        "body.thinkingKey": Object.prototype.hasOwnProperty.call(parsedBody, "thinking"),
        "body.contextManagementKey": Object.prototype.hasOwnProperty.call(parsedBody, "context_management"),
        "body.toolsKey": Object.prototype.hasOwnProperty.call(parsedBody, "tools"),
        "prompt.identityString": getSystemText(identityBlock ?? {}),
        "prompt.billingBlockPlacement": billingBlock === systemBlocks[0] ? "prepend" : "append",
        "prompt.appendMode": systemBlocks.some((block) => {
            const text = getSystemText(block);
            return (
                text.length > 0 &&
                !text.startsWith("x-anthropic-billing-header:") &&
                text !== "You are Claude Code, Anthropic's official CLI for Claude."
            );
        }),
        "prompt.cacheControlBehavior":
            identityBlock && typeof identityBlock.cache_control === "object" && identityBlock.cache_control !== null
                ? "ephemeral-identity-block"
                : "missing",
        "metadata.userIdShape": metadataSummary.userIdShape,
        "metadata.deviceLinkage": metadataSummary.deviceLinkage,
        "metadata.accountLinkage": metadataSummary.accountLinkage,
    };
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return JSON.stringify(value.map((item) => JSON.parse(stableStringify(item))));
    }

    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, JSON.parse(stableStringify(entryValue))]);
        return JSON.stringify(Object.fromEntries(entries));
    }

    return JSON.stringify(value);
}

export function compareScenarioFields(
    scenario: ScenarioDefinition,
    ogCapture: CaptureRecord,
    pluginCapture: CaptureRecord,
): ScenarioResult["fieldResults"] {
    const ogFields = extractComparableFields(ogCapture);
    const pluginFields = extractComparableFields(pluginCapture);

    return scenario.requiredFields.map((path) => {
        const ogValue = ogFields[path];
        const pluginValue = pluginFields[path];

        return {
            path,
            ogValue,
            pluginValue,
            match: stableStringify(ogValue) === stableStringify(pluginValue),
            severity: classifyRisk(path),
        };
    });
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    const allowlist = [
        "authorization",
        "anthropic-beta",
        "anthropic-version",
        "anthropic-dangerous-direct-browser-access",
        "content-type",
        "user-agent",
        "x-app",
        "x-client-request-id",
        "x-claude-code-session-id",
    ];

    for (const key of Object.keys(headers).sort()) {
        if (key.startsWith("x-stainless-") || allowlist.includes(key)) {
            if (key === "authorization") {
                sanitized[key] = headers[key]?.startsWith("Bearer ") ? "Bearer <redacted>" : "<redacted>";
                continue;
            }
            if (key === "x-client-request-id" || key === "x-claude-code-session-id") {
                sanitized[key] = "<redacted-id>";
                continue;
            }
            sanitized[key] = headers[key] ?? "";
        }
    }

    return sanitized;
}

export function sanitizeCapture(capture: CaptureRecord): Record<string, unknown> {
    return {
        capturedAt: capture.capturedAt,
        method: capture.method,
        url: capture.url,
        headers: sanitizeHeaders(capture.headers),
        normalizedFields: extractComparableFields(capture),
    };
}

function createTimestampSlug(timestamp: string): string {
    return timestamp.replace(/[:.]/g, "-");
}

export function formatProgressLine({ current, total, label, elapsedMs }: ProgressLineOptions): string {
    const safeTotal = total > 0 ? total : 1;
    const boundedCurrent = Math.min(Math.max(current, 0), safeTotal);
    const percentage = Math.round((boundedCurrent / safeTotal) * 100);
    const filled = Math.min(20, Math.round((boundedCurrent / safeTotal) * 20));
    const bar = `${"#".repeat(filled)}${"-".repeat(20 - filled)}`;
    return `[${boundedCurrent}/${safeTotal}] ${percentage}% [${bar}] ${label} (${(elapsedMs / 1000).toFixed(1)}s)`;
}

function writeProgressLine(line: string): void {
    if (!process.stderr.isTTY) {
        console.error(line);
        return;
    }

    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
    process.stderr.write(line);
}

function finishProgressLine(line: string): void {
    if (!process.stderr.isTTY) {
        console.error(line);
        return;
    }

    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
    process.stderr.write(`${line}\n`);
}

function deriveDefaultReportPath(version: string, verifiedAt: string): string {
    return resolve(DEFAULT_REPORT_DIR, `${version}-${createTimestampSlug(verifiedAt)}.json`);
}

function createEmptyParser(onRequest: (request: Omit<CaptureRecord, "capturedAt" | "url">) => void) {
    let buffer = Buffer.alloc(0);

    return {
        push(chunk: Buffer) {
            buffer = Buffer.concat([buffer, chunk]);

            while (buffer.length > 0) {
                const headerSeparatorIndex = buffer.indexOf("\r\n\r\n");
                if (headerSeparatorIndex === -1) {
                    return;
                }

                const headerBytes = buffer.subarray(0, headerSeparatorIndex).toString("latin1");
                const lines = headerBytes.split("\r\n");
                const requestLine = lines.shift() ?? "";
                const [method = "", requestPath = ""] = requestLine.split(" ");
                const headers: Record<string, string> = {};

                for (const line of lines) {
                    const separatorIndex = line.indexOf(":");
                    if (separatorIndex <= 0) {
                        continue;
                    }
                    const key = line.slice(0, separatorIndex).trim().toLowerCase();
                    headers[key] = line.slice(separatorIndex + 1).trim();
                }

                const contentLengthHeader = headers["content-length"];
                const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : 0;
                if (!Number.isFinite(contentLength) || contentLength < 0) {
                    throw new Error(`Unsupported content-length: ${contentLengthHeader}`);
                }

                const totalRequestLength = headerSeparatorIndex + 4 + contentLength;
                if (buffer.length < totalRequestLength) {
                    return;
                }

                const bodyBuffer = buffer.subarray(headerSeparatorIndex + 4, totalRequestLength);
                buffer = buffer.subarray(totalRequestLength);

                onRequest({
                    method,
                    path: requestPath,
                    headers,
                    bodyText: bodyBuffer.toString("utf8"),
                    parsedBody: parseJson(bodyBuffer.toString("utf8")),
                });
            }
        },
    };
}

function ensureCerts(certDir: string): { key: Buffer; cert: Buffer } {
    mkdirSync(certDir, { recursive: true });
    const caKey = join(certDir, "ca.key");
    const caCert = join(certDir, "ca.crt");
    const serverKey = join(certDir, "srv.key");
    const serverCert = join(certDir, "srv.crt");
    const serverCsr = join(certDir, "srv.csr");
    const extCnf = join(certDir, "ext.cnf");

    try {
        if (!readableFileExists(caKey)) {
            execFileSync("openssl", ["genrsa", "-out", caKey, "2048"], { stdio: "pipe" });
            execFileSync(
                "openssl",
                [
                    "req",
                    "-new",
                    "-x509",
                    "-days",
                    "365",
                    "-key",
                    caKey,
                    "-out",
                    caCert,
                    "-subj",
                    "/CN=Trusted Local Verification CA",
                ],
                { stdio: "pipe" },
            );
            execFileSync("openssl", ["genrsa", "-out", serverKey, "2048"], { stdio: "pipe" });
            execFileSync(
                "openssl",
                ["req", "-new", "-key", serverKey, "-out", serverCsr, "-subj", "/CN=api.anthropic.com"],
                { stdio: "pipe" },
            );
            writeFileSync(extCnf, "[ext]\nsubjectAltName=DNS:*.anthropic.com,DNS:api.anthropic.com\n", "utf8");
            execFileSync(
                "openssl",
                [
                    "x509",
                    "-req",
                    "-days",
                    "365",
                    "-in",
                    serverCsr,
                    "-CA",
                    caCert,
                    "-CAkey",
                    caKey,
                    "-CAcreateserial",
                    "-out",
                    serverCert,
                    "-extfile",
                    extCnf,
                    "-extensions",
                    "ext",
                ],
                { stdio: "pipe" },
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to generate proxy certificates in ${certDir}: ${message}`);
    }

    return {
        key: readFileSync(serverKey),
        cert: readFileSync(serverCert),
    };
}

function readableFileExists(filePath: string): boolean {
    try {
        readFileSync(filePath);
        return true;
    } catch {
        return false;
    }
}

async function startCaptureProxy(options: { host: string; port?: number }): Promise<CaptureProxy> {
    const captures: CaptureRecord[] = [];
    const certDir = mkdtempSync(join(tmpdir(), "verification-proxy-certs-"));
    const certs = ensureCerts(certDir);

    const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end("verification proxy ok");
    });

    server.on("connect", (request, clientSocket) => {
        const authority = request.headers.host || request.url || "";
        const [hostname = "", portText = "443"] = authority.split(":");
        const port = Number.parseInt(portText || "443", 10);
        clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n");

        const tlsSocket = new tls.TLSSocket(clientSocket, {
            isServer: true,
            key: certs.key,
            cert: certs.cert,
            rejectUnauthorized: false,
        });
        const parser = createEmptyParser((capturedRequest) => {
            const url = `https://${hostname}:${port}${capturedRequest.path}`;
            captures.push({
                ...capturedRequest,
                capturedAt: new Date().toISOString(),
                url,
            });
        });

        const upstream = tls.connect({ host: hostname, port, rejectUnauthorized: false });
        const queuedChunks: Buffer[] = [];
        let upstreamReady = false;

        upstream.on("secureConnect", () => {
            upstreamReady = true;
            for (const chunk of queuedChunks.splice(0)) {
                upstream.write(chunk);
            }
        });
        upstream.on("data", (chunk) => {
            tlsSocket.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstream.on("end", () => {
            tlsSocket.destroy();
        });
        upstream.on("error", () => {
            tlsSocket.destroy();
        });

        tlsSocket.on("data", (chunk) => {
            const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            parser.push(bufferChunk);
            if (upstreamReady) {
                upstream.write(bufferChunk);
            } else {
                queuedChunks.push(bufferChunk);
            }
        });
        tlsSocket.on("end", () => {
            upstream.destroy();
        });
        tlsSocket.on("error", () => {
            upstream.destroy();
        });
    });

    const listeningPort = await new Promise<number>((resolvePort, reject) => {
        server.once("error", (error) => {
            reject(new Error(`Failed to start proxy capture server: ${error.message}`));
        });
        server.listen(options.port ?? 0, options.host, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("Proxy listen address was unavailable"));
                return;
            }
            resolvePort(address.port);
        });
    });

    return {
        port: listeningPort,
        captures,
        close: () =>
            new Promise<void>((resolveClose, rejectClose) => {
                server.close((error) => {
                    if (error) {
                        rejectClose(error);
                        return;
                    }
                    resolveClose();
                });
            }),
    };
}

function findPromptTextInCapture(capture: CaptureRecord): string {
    const parsedBody = capture.parsedBody;
    if (!parsedBody || typeof parsedBody !== "object") {
        return "";
    }

    const messages = Array.isArray((parsedBody as Record<string, unknown>).messages)
        ? ((parsedBody as Record<string, unknown>).messages as unknown[])
        : [];
    const texts: string[] = [];

    for (const message of messages) {
        if (!message || typeof message !== "object") {
            continue;
        }
        const messageContent = (message as Record<string, unknown>).content;
        if (typeof messageContent === "string") {
            texts.push(messageContent);
            continue;
        }
        if (!Array.isArray(messageContent)) {
            continue;
        }
        for (const block of messageContent) {
            if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
                const text = (block as Record<string, unknown>).text;
                if (typeof text === "string") {
                    texts.push(text);
                }
            }
        }
    }

    return texts.join("\n");
}

export function selectCaptureForScenario(
    captures: CaptureRecord[],
    scenario: ScenarioDefinition,
): CaptureRecord | undefined {
    const pathNeedle = scenario.requestPathContains ?? "/v1/messages";
    return captures.find((capture) => {
        if (!capture.path.includes(pathNeedle)) {
            return false;
        }
        if (scenario.runnerMode === "manual") {
            return true;
        }
        return findPromptTextInCapture(capture).includes(scenario.prompt);
    });
}

async function runCommand(
    template: string,
    prompt: string,
    env: NodeJS.ProcessEnv,
    progress?: { current: number; total: number; label: string },
    timeoutMs = 120_000,
): Promise<CommandResult> {
    const renderedCommand = renderCommand(template, prompt);

    return await new Promise<CommandResult>((resolveCommand, rejectCommand) => {
        const child = spawn("bash", ["-lc", renderedCommand], {
            cwd: REPO_ROOT,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
        });

        let stdout = "";
        let stderr = "";
        let didTimeout = false;
        const killProcessGroup = (signal: NodeJS.Signals) => {
            if (!child.pid) {
                return;
            }
            try {
                process.kill(-child.pid, signal);
            } catch {
                child.kill(signal);
            }
        };
        const startedAt = Date.now();
        const interval =
            progress == null
                ? null
                : setInterval(() => {
                      writeProgressLine(
                          formatProgressLine({
                              current: progress.current,
                              total: progress.total,
                              label: progress.label,
                              elapsedMs: Date.now() - startedAt,
                          }),
                      );
                  }, 1000);

        const stopProgress = (suffix: string) => {
            if (interval) {
                clearInterval(interval);
            }
            if (progress) {
                finishProgressLine(
                    formatProgressLine({
                        current: progress.current,
                        total: progress.total,
                        label: `${progress.label} ${suffix}`,
                        elapsedMs: Date.now() - startedAt,
                    }),
                );
            }
        };
        const timeout = setTimeout(() => {
            didTimeout = true;
            killProcessGroup("SIGTERM");
            setTimeout(() => {
                killProcessGroup("SIGKILL");
            }, 2000).unref();
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            clearTimeout(timeout);
            stopProgress("failed");
            rejectCommand(new Error(`Failed to start command: ${error.message}`));
        });
        child.on("close", (code, signal) => {
            clearTimeout(timeout);
            if (code === 0) {
                stopProgress("done");
                resolveCommand({ stdout, stderr });
                return;
            }
            stopProgress("failed");
            rejectCommand(
                new Error(
                    didTimeout || signal === "SIGTERM" || signal === "SIGKILL"
                        ? `Command timed out after ${timeoutMs}ms: ${renderedCommand}\n${stderr.trim() || stdout.trim() || "(no output)"}`
                        : `Command failed with exit ${code}: ${renderedCommand}\n${stderr.trim() || stdout.trim() || "(no output)"}`,
                ),
            );
        });
    });
}

async function runScenario(
    proxy: CaptureProxy,
    scenario: ScenarioDefinition,
    args: ParsedArgs,
    progress: { current: number; total: number },
): Promise<ScenarioResult> {
    if (scenario.runnerMode === "manual") {
        return {
            scenarioId: scenario.id,
            passed: false,
            ogCapture: null,
            pluginCapture: null,
            fieldResults: [],
            error: `${scenario.id} requires a custom manual flow (${scenario.notes?.join(" ") ?? "see runbook"})`,
        };
    }

    const baseCaptureCount = proxy.captures.length;
    const proxyUrl = `http://${args.proxyHost}:${proxy.port}`;
    const commandEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        BUN_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
    };
    delete commandEnv.HTTP_PROXY;
    delete commandEnv.http_proxy;
    delete commandEnv.ALL_PROXY;
    delete commandEnv.all_proxy;

    try {
        await runCommand(args.ogCommandTemplate, scenario.prompt, commandEnv, {
            ...progress,
            label: `${scenario.id}: OG capture`,
        }, args.commandTimeoutMs);
        const ogCapture = selectCaptureForScenario(proxy.captures.slice(baseCaptureCount), scenario);
        if (!ogCapture) {
            throw new Error(`OG command did not produce a capture for ${scenario.id}`);
        }

        const captureCountAfterOg = proxy.captures.length;
        await runCommand(args.pluginCommandTemplate, scenario.prompt, commandEnv, {
            ...progress,
            label: `${scenario.id}: plugin capture`,
        }, args.commandTimeoutMs);
        const pluginCapture = selectCaptureForScenario(proxy.captures.slice(captureCountAfterOg), scenario);
        if (!pluginCapture) {
            throw new Error(`Plugin command did not produce a capture for ${scenario.id}`);
        }

        const fieldResults = compareScenarioFields(scenario, ogCapture, pluginCapture);
        return {
            scenarioId: scenario.id,
            passed: fieldResults.every((result) => result.match),
            ogCapture: sanitizeCapture(ogCapture),
            pluginCapture: sanitizeCapture(pluginCapture),
            fieldResults,
        };
    } catch (error) {
        return {
            scenarioId: scenario.id,
            passed: false,
            ogCapture: null,
            pluginCapture: null,
            fieldResults: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function runOfflineScenario(scenario: ScenarioDefinition, ogCapture: CaptureRecord, pluginCapture: CaptureRecord): ScenarioResult {
    const fieldResults = compareScenarioFields(scenario, ogCapture, pluginCapture);
    return {
        scenarioId: scenario.id,
        passed: fieldResults.every((result) => result.match),
        ogCapture: sanitizeCapture(ogCapture),
        pluginCapture: sanitizeCapture(pluginCapture),
        fieldResults,
    };
}

function buildSummary(scenarioResults: ScenarioResult[]): VerificationReport["summary"] {
    const allFieldResults = scenarioResults.flatMap((scenario) => scenario.fieldResults);
    const totalFields = allFieldResults.length;
    const matchingFields = allFieldResults.filter((field) => field.match).length;

    return {
        totalScenarios: scenarioResults.length,
        passedScenarios: scenarioResults.filter((scenario) => scenario.passed).length,
        failedScenarios: scenarioResults.filter((scenario) => !scenario.passed).length,
        totalFields,
        matchingFields,
        mismatchedFields: totalFields - matchingFields,
    };
}

function writeReport(reportPath: string, report: VerificationReport): void {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function printResult(reportPath: string, report: VerificationReport): void {
    const severityCounts = report.scenarioResults
        .flatMap((scenario) => scenario.fieldResults)
        .filter((field) => !field.match)
        .reduce<Record<FieldRisk, number>>(
            (counts, field) => {
                counts[field.severity] += 1;
                return counts;
            },
            { critical: 0, sensitive: 0, "low-risk": 0 },
        );

    console.log(
        JSON.stringify(
            {
                version: report.version,
                verifiedAt: report.verifiedAt,
                verifiedBy: report.verifiedBy,
                reportPath,
                summary: report.summary,
                mismatchesByRisk: severityCounts,
                scenarios: report.scenarioResults.map((scenario) => ({
                    scenarioId: scenario.scenarioId,
                    passed: scenario.passed,
                    mismatches: scenario.fieldResults
                        .filter((field) => !field.match)
                        .map((field) => ({
                            path: field.path,
                            severity: field.severity,
                        })),
                    error: scenario.error,
                })),
            },
            null,
            2,
        ),
    );
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }

    validateCandidateManifest(readJsonFile<CandidateManifest>(args.candidatePath));

    const scenarios = selectScenarios(loadScenarioDefinitions(args.scenarioDir), args.scenarioIds);
    if (scenarios.length === 0) {
        throw new Error("No runnable scenarios selected. Use --scenario to include a manual scenario explicitly.");
    }

    const verifiedAt = new Date().toISOString();
    const offlineOgCapture = args.ogCapturePath ? normalizeStoredCapture(readJsonFile<unknown>(args.ogCapturePath)) : null;
    const offlinePluginCapture = args.pluginCapturePath
        ? normalizeStoredCapture(readJsonFile<unknown>(args.pluginCapturePath))
        : null;

    if ((offlineOgCapture && !offlinePluginCapture) || (!offlineOgCapture && offlinePluginCapture)) {
        throw new Error("--og-capture and --plugin-capture must be provided together");
    }

    const proxy = offlineOgCapture && offlinePluginCapture ? null : await startCaptureProxy({ host: args.proxyHost, port: args.proxyPort });

    try {
        const scenarioResults: ScenarioResult[] = [];
        for (const [index, scenario] of scenarios.entries()) {
            if (offlineOgCapture && offlinePluginCapture) {
                scenarioResults.push(runOfflineScenario(scenario, offlineOgCapture, offlinePluginCapture));
                continue;
            }
            scenarioResults.push(await runScenario(proxy!, scenario, args, { current: index + 1, total: scenarios.length }));
        }

        const report: VerificationReport = {
            version: args.version,
            verifiedAt,
            verifiedBy: args.verifiedBy,
            scenarioResults,
            summary: buildSummary(scenarioResults),
        };

        const reportPath = args.reportPath ?? deriveDefaultReportPath(args.version, verifiedAt);
        writeReport(reportPath, report);
        printResult(reportPath, report);
        if (report.summary.failedScenarios > 0 || report.summary.mismatchedFields > 0) {
            process.exitCode = 2;
        }
    } finally {
        if (proxy) {
            await proxy.close();
        }
    }
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
