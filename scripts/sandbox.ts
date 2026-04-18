#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(currentFilePath), "..");

const SANDBOX_ROOT = process.env.SANDBOX_ROOT ? resolve(process.env.SANDBOX_ROOT) : join(REPO_ROOT, ".sandbox");

const SANDBOX_CONFIG_HOME = join(SANDBOX_ROOT, "config");
const SANDBOX_DATA_HOME = join(SANDBOX_ROOT, "data");
const SANDBOX_CACHE_HOME = join(SANDBOX_ROOT, "cache");
const SANDBOX_BIN_DIR = join(SANDBOX_ROOT, "bin");
const SANDBOX_PLUGIN_DIR = join(SANDBOX_CONFIG_HOME, "opencode", "plugin");
const SANDBOX_OPENCODE_CONFIG_DIR = join(SANDBOX_CONFIG_HOME, "opencode");
const SANDBOX_OPENCODE_CONFIG_PATH = join(SANDBOX_OPENCODE_CONFIG_DIR, "opencode.json");

const DIST_DIR = join(REPO_ROOT, "dist");
const PLUGIN_DIST = join(DIST_DIR, "opencode-anthropic-auth-plugin.mjs");
const CLI_DIST = join(DIST_DIR, "opencode-anthropic-auth-cli.mjs");

const PLUGIN_ENTRY_NAME = "opencode-anthropic-auth-plugin.js";
const CLI_BIN_NAME = "opencode-anthropic-auth";

const PLUGIN_ENTRY_PATH = join(SANDBOX_PLUGIN_DIR, PLUGIN_ENTRY_NAME);
const CLI_BIN_PATH = join(SANDBOX_BIN_DIR, CLI_BIN_NAME);

const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const green = (t: string) => `\x1b[32m${t}\x1b[0m`;
const yellow = (t: string) => `\x1b[33m${t}\x1b[0m`;
const red = (t: string) => `\x1b[31m${t}\x1b[0m`;
const dim = (t: string) => `\x1b[2m${t}\x1b[0m`;

function logStep(message: string): void {
    console.log(dim(`  → ${message}`));
}

function runCommandSync(command: string, args: string[]): void {
    const result = spawnSync(command, args, {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(" ")} (exit ${result.status ?? "null"})`);
    }
}

async function ensureDistBundles(): Promise<void> {
    if (!existsSync(PLUGIN_DIST) || !existsSync(CLI_DIST)) {
        logStep("Building plugin + CLI bundles (bun run build)");
        runCommandSync("bun", ["run", "build"]);
    } else {
        logStep("Using existing dist/ bundles");
    }
}

async function copyBundlesIntoSandbox(): Promise<void> {
    await mkdir(SANDBOX_PLUGIN_DIR, { recursive: true });
    await mkdir(SANDBOX_BIN_DIR, { recursive: true });

    await copyFile(PLUGIN_DIST, PLUGIN_ENTRY_PATH);
    await copyFile(CLI_DIST, CLI_BIN_PATH);
    await chmod(CLI_BIN_PATH, 0o755);

    logStep(`Copied plugin → ${PLUGIN_ENTRY_PATH}`);
    logStep(`Copied CLI    → ${CLI_BIN_PATH}`);
}

async function writeSandboxOpencodeConfig(): Promise<void> {
    if (existsSync(SANDBOX_OPENCODE_CONFIG_PATH)) {
        logStep(`Preserving existing opencode.json at ${SANDBOX_OPENCODE_CONFIG_PATH}`);
        return;
    }
    const configBody = {
        $schema: "https://opencode.ai/config.json",
    };
    await mkdir(SANDBOX_OPENCODE_CONFIG_DIR, { recursive: true });
    await writeFile(SANDBOX_OPENCODE_CONFIG_PATH, `${JSON.stringify(configBody, null, 2)}\n`, "utf8");
    logStep(`Wrote ${SANDBOX_OPENCODE_CONFIG_PATH}`);
}

async function cmdUp(): Promise<void> {
    console.log(bold(`Bringing up sandbox at ${SANDBOX_ROOT}`));

    await mkdir(SANDBOX_CONFIG_HOME, { recursive: true });
    await mkdir(SANDBOX_DATA_HOME, { recursive: true });
    await mkdir(SANDBOX_CACHE_HOME, { recursive: true });
    await mkdir(SANDBOX_BIN_DIR, { recursive: true });

    await ensureDistBundles();
    await copyBundlesIntoSandbox();
    await writeSandboxOpencodeConfig();

    console.log(green("\nSandbox ready."));
    console.log(dim("  Activate with:  source scripts/sandbox-env.sh"));
    console.log(dim("  Run opencode:   bun scripts/sandbox.ts run -- [opencode-args]"));
    console.log(dim(`  Plugin path:    ${PLUGIN_ENTRY_PATH}`));
    console.log(dim(`  CLI path:       ${CLI_BIN_PATH}`));
}

async function cmdDown(): Promise<void> {
    if (!existsSync(SANDBOX_ROOT)) {
        console.log(dim(`Sandbox not present at ${SANDBOX_ROOT}. Nothing to remove.`));
        return;
    }
    await rm(SANDBOX_ROOT, { recursive: true, force: true });
    console.log(green(`Removed sandbox at ${SANDBOX_ROOT}`));
}

async function cmdReinstall(): Promise<void> {
    if (!existsSync(SANDBOX_ROOT)) {
        console.log(yellow("Sandbox not found. Running 'up' instead."));
        await cmdUp();
        return;
    }
    console.log(bold(`Reinstalling plugin + CLI into ${SANDBOX_ROOT}`));
    await ensureDistBundles();
    await copyBundlesIntoSandbox();
    console.log(green("Reinstall complete. Sandbox config/state preserved."));
}

async function cmdRun(args: string[]): Promise<void> {
    if (!existsSync(PLUGIN_ENTRY_PATH) || !existsSync(CLI_BIN_PATH)) {
        console.error(red(`Sandbox not ready. Run 'bun scripts/sandbox.ts up' first.`));
        process.exit(1);
    }

    const sandboxEnv = {
        ...process.env,
        XDG_CONFIG_HOME: SANDBOX_CONFIG_HOME,
        XDG_DATA_HOME: SANDBOX_DATA_HOME,
        XDG_CACHE_HOME: SANDBOX_CACHE_HOME,
        PATH: `${SANDBOX_BIN_DIR}:${process.env.PATH ?? ""}`,
        OPENCODE_ANTHROPIC_DEBUG: process.env.OPENCODE_ANTHROPIC_DEBUG ?? "1",
        SANDBOX_ROOT,
    };

    const result = spawnSync("opencode", args, {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: sandboxEnv,
    });

    if (result.error) {
        const err = result.error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
            console.error(red("'opencode' binary not found on PATH. Install OpenCode first."));
        } else {
            console.error(red(`Failed to launch opencode: ${err.message}`));
        }
        process.exit(1);
    }
    process.exit(result.status ?? 0);
}

async function cmdStatus(): Promise<void> {
    if (!existsSync(SANDBOX_ROOT)) {
        console.log(yellow(`Sandbox not installed at ${SANDBOX_ROOT}`));
        return;
    }

    console.log(bold(`Sandbox at ${SANDBOX_ROOT}`));

    const pluginExists = existsSync(PLUGIN_ENTRY_PATH);
    const cliExists = existsSync(CLI_BIN_PATH);

    console.log(`  plugin: ${pluginExists ? green("installed") : red("missing")}`);
    if (pluginExists) {
        const stats = await stat(PLUGIN_ENTRY_PATH);
        console.log(dim(`    path:  ${PLUGIN_ENTRY_PATH}`));
        console.log(dim(`    size:  ${stats.size} bytes`));
        console.log(dim(`    mtime: ${stats.mtime.toISOString()}`));
    }

    console.log(`  CLI:    ${cliExists ? green("installed") : red("missing")}`);
    if (cliExists) {
        const stats = await stat(CLI_BIN_PATH);
        console.log(dim(`    path:  ${CLI_BIN_PATH}`));
        console.log(dim(`    size:  ${stats.size} bytes`));
        console.log(dim(`    mtime: ${stats.mtime.toISOString()}`));
    }

    const opencodeConfigExists = existsSync(SANDBOX_OPENCODE_CONFIG_PATH);
    console.log(`  opencode.json: ${opencodeConfigExists ? green("present") : yellow("absent")}`);
}

function printUsage(): void {
    console.log(`${bold("scripts/sandbox.ts")} - isolated OpenCode dev sandbox

${dim("Sandbox root:")}
  ${SANDBOX_ROOT}

${dim("Commands:")}
  ${bold("up")}         Build + install plugin and CLI into the sandbox
  ${bold("down")}       Remove the sandbox tree entirely
  ${bold("reinstall")}  Rebuild and copy plugin + CLI without wiping state
  ${bold("run")} ...    Launch 'opencode' with sandbox XDG vars (args after 'run' are forwarded)
  ${bold("status")}     Show sandbox installation state
  ${bold("help")}       Show this message

${dim("Environment:")}
  SANDBOX_ROOT   Override sandbox root (default: ./.sandbox)
`);
}

async function main(): Promise<void> {
    const [, , command, ...rest] = process.argv;

    try {
        switch (command) {
            case "up":
                await cmdUp();
                break;
            case "down":
                await cmdDown();
                break;
            case "reinstall":
                await cmdReinstall();
                break;
            case "run":
                await cmdRun(rest);
                break;
            case "status":
                await cmdStatus();
                break;
            case "help":
            case undefined:
                printUsage();
                process.exit(command ? 0 : 1);
                break;
            default:
                console.error(red(`Unknown command: ${command}`));
                printUsage();
                process.exit(1);
        }
    } catch (error) {
        console.error(red(`Error: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

await main();
