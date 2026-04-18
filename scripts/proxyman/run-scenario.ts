#!/usr/bin/env bun

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clearLine, cursorTo } from "node:readline";
import { fileURLToPath } from "node:url";

import { loadScenarioDefinitions } from "../verification/run-live-verification.ts";
import { loadHarCaptures, selectCapture, type NormalizeHarArgs } from "./normalize-har.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_SCENARIO_DIR = resolve(REPO_ROOT, "scripts/verification/scenarios");
const DEFAULT_REPORT_DIR = resolve(REPO_ROOT, "manifests/reports/proxyman");
const DEFAULT_OG_COMMAND_TEMPLATE = "claude --bare --print {prompt}";
const DEFAULT_PLUGIN_COMMAND_TEMPLATE = "opencode run {prompt}";
const DEFAULT_PROXYMAN_CLI_PATH = "/Applications/Proxyman.app/Contents/MacOS/proxyman-cli";
const DEFAULT_PROXYMAN_ENV_SCRIPT =
    "/Users/vacbo/Library/Application Support/com.proxyman.NSProxy/app-data/proxyman_env_automatic_setup.sh";

interface ParsedArgs {
    version: string;
    scenarioId: string;
    scenarioDir: string;
    outputDir: string;
    proxymanCliPath: string;
    proxymanEnvScript: string;
    ogCommandTemplate: string;
    pluginCommandTemplate: string;
    commandTimeoutMs: number;
    settleMs: number;
    help: boolean;
}

function printUsage(): void {
    console.log(`Usage: bun scripts/proxyman/run-scenario.ts --version <ver> --scenario <id>

Runs OG Claude Code and the plugin/OpenCode through Proxyman, exports HAR captures,
normalizes them into CaptureRecord artifacts, and invokes the existing offline verifier.

Requirements:
  - Proxyman app is running
  - Recording is enabled in Proxyman
  - proxyman-cli is available (default: ${DEFAULT_PROXYMAN_CLI_PATH})
  - Proxyman automatic setup shell env script exists

Options:
  --version <ver>                  Candidate manifest version to verify
  --scenario <id>                 Scenario ID from scripts/verification/scenarios
  --scenario-dir <path>           Scenario definition directory
                                   Default: scripts/verification/scenarios
  --output-dir <path>             Directory for HAR exports, normalized captures, and report
                                   Default: manifests/reports/proxyman/<scenario>-<timestamp>
  --proxyman-cli <path>           proxyman-cli binary path
                                   Default: ${DEFAULT_PROXYMAN_CLI_PATH}
  --proxyman-env-script <path>    Proxyman automatic setup shell env script path
                                   Default: ${DEFAULT_PROXYMAN_ENV_SCRIPT}
  --og-command-template <cmd>     Shell template for OG Claude Code
                                   Default: ${DEFAULT_OG_COMMAND_TEMPLATE}
  --plugin-command-template <cmd> Shell template for plugin/OpenCode
                                   Default: ${DEFAULT_PLUGIN_COMMAND_TEMPLATE}
  --command-timeout-ms <ms>       Kill commands that exceed this duration
                                   Default: 120000
  --settle-ms <ms>                Wait after command exits before exporting Proxyman logs
                                   Default: 1000
  --help                          Show this help message
`);
}

function createTimestampSlug(timestamp: string): string {
    return timestamp.replace(/[:.]/g, "-");
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(template: string, prompt: string): string {
    return template.split("{prompt}").join(shellQuote(prompt));
}

function renderSourcedCommand(envScriptPath: string, command: string): string {
    const quotedEnvScriptPath = shellQuote(envScriptPath);
    return ["set -a 2>/dev/null || true", `source ${quotedEnvScriptPath}`, "set +a 2>/dev/null || true", command].join(
        "; ",
    );
}

function parseArgs(args: string[]): ParsedArgs {
    let version = "";
    let scenarioId = "";
    let scenarioDir = DEFAULT_SCENARIO_DIR;
    let outputDir = "";
    let proxymanCliPath = DEFAULT_PROXYMAN_CLI_PATH;
    let proxymanEnvScript = DEFAULT_PROXYMAN_ENV_SCRIPT;
    let ogCommandTemplate = DEFAULT_OG_COMMAND_TEMPLATE;
    let pluginCommandTemplate = DEFAULT_PLUGIN_COMMAND_TEMPLATE;
    let commandTimeoutMs = 120_000;
    let settleMs = 1_000;
    let help = false;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help") {
            help = true;
            continue;
        }
        if (arg === "--version" && index + 1 < args.length) {
            version = (args[index + 1] ?? "").trim();
            index += 1;
            continue;
        }
        if (arg === "--scenario" && index + 1 < args.length) {
            scenarioId = (args[index + 1] ?? "").trim();
            index += 1;
            continue;
        }
        if (arg === "--scenario-dir" && index + 1 < args.length) {
            scenarioDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--output-dir" && index + 1 < args.length) {
            outputDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--proxyman-cli" && index + 1 < args.length) {
            proxymanCliPath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--proxyman-env-script" && index + 1 < args.length) {
            proxymanEnvScript = resolve(args[index + 1] ?? "");
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
        if (arg === "--command-timeout-ms" && index + 1 < args.length) {
            commandTimeoutMs = Number.parseInt(args[index + 1] ?? "", 10);
            index += 1;
            continue;
        }
        if (arg === "--settle-ms" && index + 1 < args.length) {
            settleMs = Number.parseInt(args[index + 1] ?? "", 10);
            index += 1;
            continue;
        }
    }

    if (!help && !version) {
        throw new Error("Missing required --version <ver>");
    }
    if (!help && !scenarioId) {
        throw new Error("Missing required --scenario <id>");
    }
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
        throw new Error("--command-timeout-ms must be a positive integer");
    }
    if (!Number.isInteger(settleMs) || settleMs < 0) {
        throw new Error("--settle-ms must be a non-negative integer");
    }

    const defaultOutputDir = resolve(
        DEFAULT_REPORT_DIR,
        `${scenarioId}-${createTimestampSlug(new Date().toISOString())}`,
    );

    return {
        version,
        scenarioId,
        scenarioDir,
        outputDir: outputDir || defaultOutputDir,
        proxymanCliPath,
        proxymanEnvScript,
        ogCommandTemplate,
        pluginCommandTemplate,
        commandTimeoutMs,
        settleMs,
        help,
    };
}

function runCli(proxymanCliPath: string, args: string[]): string {
    try {
        return execFileSync(proxymanCliPath, args, {
            encoding: "utf8",
            cwd: REPO_ROOT,
        }).trim();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`proxyman-cli ${args.join(" ")} failed: ${message}`);
    }
}

function validateProxymanEnvScript(filePath: string): void {
    if (!existsSync(filePath)) {
        throw new Error(`Proxyman env script not found: ${filePath}`);
    }
}

function clearSession(proxymanCliPath: string): void {
    runCli(proxymanCliPath, ["clear-session"]);
}

function exportHar(proxymanCliPath: string, outputPath: string): void {
    runCli(proxymanCliPath, [
        "export-log",
        "--mode",
        "domains",
        "--domains",
        "api.anthropic.com",
        "--output",
        outputPath,
        "--format",
        "har",
    ]);
}

function findScenario(scenarioDir: string, scenarioId: string) {
    const scenario = loadScenarioDefinitions(scenarioDir).find((entry) => entry.id === scenarioId);
    if (!scenario) {
        throw new Error(`Unknown scenario: ${scenarioId}`);
    }
    return scenario;
}

function formatProgressLine(label: string, elapsedMs: number): string {
    return `[proxyman] ${label} (${(elapsedMs / 1000).toFixed(1)}s)`;
}

async function runCommand(
    template: string,
    prompt: string,
    proxymanEnvScript: string,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const renderedCommand = renderSourcedCommand(proxymanEnvScript, renderCommand(template, prompt));
    const startedAt = Date.now();

    await new Promise<void>((resolveCommand, rejectCommand) => {
        const child = spawn("sh", ["-lc", renderedCommand], {
            cwd: REPO_ROOT,
            env: process.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        let stdout = "";
        let didTimeout = false;
        const killProcessGroup = (signal: NodeJS.Signals) => {
            if (child.pid) {
                try {
                    process.kill(-child.pid, signal);
                } catch {
                    // ignore missing process group
                }
            }
        };

        const timer = setInterval(() => {
            if (process.stderr.isTTY) {
                clearLine(process.stderr, 0);
                cursorTo(process.stderr, 0);
                process.stderr.write(formatProgressLine(label, Date.now() - startedAt));
            }
        }, 250);

        const timeout = setTimeout(() => {
            didTimeout = true;
            killProcessGroup("SIGTERM");
            setTimeout(() => killProcessGroup("SIGKILL"), 2000).unref();
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            clearTimeout(timeout);
            clearInterval(timer);
            rejectCommand(new Error(`Failed to start command: ${error.message}`));
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            clearInterval(timer);
            if (process.stderr.isTTY) {
                clearLine(process.stderr, 0);
                cursorTo(process.stderr, 0);
            }
            if (code === 0) {
                resolveCommand();
                return;
            }
            rejectCommand(
                new Error(
                    didTimeout
                        ? `Command timed out after ${timeoutMs}ms: ${renderedCommand}\n${stderr.trim() || stdout.trim() || "(no output)"}`
                        : `Command failed with exit ${code}: ${renderedCommand}\n${stderr.trim() || stdout.trim() || "(no output)"}`,
                ),
            );
        });
    });
}

function createNormalizeArgs(
    harPath: string,
    outPath: string,
    scenarioId: string,
    scenarioDir: string,
): NormalizeHarArgs {
    return {
        harPath,
        outPath,
        scenarioId,
        scenarioDir,
        hostContains: undefined,
        pathContains: undefined,
        promptContains: undefined,
        selectLast: false,
        help: false,
    };
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureRun(
    label: "og" | "plugin",
    commandTemplate: string,
    args: ParsedArgs,
    scenarioPrompt: string,
): Promise<string> {
    clearSession(args.proxymanCliPath);

    await runCommand(
        commandTemplate,
        scenarioPrompt,
        args.proxymanEnvScript,
        args.commandTimeoutMs,
        `${args.scenarioId}: ${label}`,
    );
    await sleep(args.settleMs);

    const harPath = join(args.outputDir, `${args.scenarioId}-${label}.har`);
    const capturePath = join(args.outputDir, `${args.scenarioId}-${label}-capture.json`);
    exportHar(args.proxymanCliPath, harPath);

    const normalized = selectCapture(
        loadHarCaptures(harPath),
        createNormalizeArgs(harPath, capturePath, args.scenarioId, args.scenarioDir),
    );
    mkdirSync(dirname(capturePath), { recursive: true });
    writeFileSync(capturePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return capturePath;
}

function runOfflineVerification(
    args: ParsedArgs,
    ogCapturePath: string,
    pluginCapturePath: string,
    reportPath: string,
): void {
    try {
        execFileSync(
            process.execPath,
            [
                "scripts/verification/run-live-verification.ts",
                "--version",
                args.version,
                "--scenario",
                args.scenarioId,
                "--og-capture",
                ogCapturePath,
                "--plugin-capture",
                pluginCapturePath,
                "--report",
                reportPath,
            ],
            { cwd: REPO_ROOT, stdio: "inherit" },
        );
    } catch (error) {
        if (existsSync(reportPath)) {
            console.warn(`\n[proxyman] Offline verification reported mismatches. Report preserved at ${reportPath}.`);
            return;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Offline verification failed before writing a report: ${message}`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }

    validateProxymanEnvScript(args.proxymanEnvScript);
    mkdirSync(args.outputDir, { recursive: true });
    const scenario = findScenario(args.scenarioDir, args.scenarioId);

    const ogCapturePath = await captureRun("og", args.ogCommandTemplate, args, scenario.prompt);
    const pluginCapturePath = await captureRun("plugin", args.pluginCommandTemplate, args, scenario.prompt);

    const reportPath = join(args.outputDir, `${args.scenarioId}-verification-report.json`);
    runOfflineVerification(args, ogCapturePath, pluginCapturePath, reportPath);

    console.log(`\nArtifacts written to ${args.outputDir}`);
    console.log(`- OG capture: ${ogCapturePath}`);
    console.log(`- Plugin capture: ${pluginCapturePath}`);
    console.log(`- Report: ${reportPath}`);
}

if (import.meta.main) {
    await main();
}
