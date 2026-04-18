#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const ACCOUNTS_PATH = resolve(homedir(), ".config/opencode/anthropic-accounts.json");
const OUTPUT_DIR = resolve(REPO_ROOT, "manifests/smoke");
const CACHE_PATH = join(OUTPUT_DIR, "failed-models.json");
const RESULTS_PATH = join(OUTPUT_DIR, "model-smoke-test.json");

const DEFAULT_MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"];
const ALL_MODELS = [...DEFAULT_MODELS, "claude-opus-4-7"];
const DEFAULT_SCENARIO_PROMPT = "hi";
const API_URL = "https://api.anthropic.com/v1/messages";

export interface FailedModelEntry {
    lastTested: string;
    lastPassedAt: string | null;
    error: string;
    consecutiveFailures: number;
}

export type FailedModelsCache = Record<string, FailedModelEntry>;

export interface ModelResult {
    model: string;
    status: "pass" | "fail";
    timeMs: number;
    error: string | null;
}

export interface SkippedModel {
    model: string;
    reason: string;
    lastTested: string;
    lastError: string;
}

export interface SmokeOptions {
    forceAll: boolean;
    models: string[];
    scenarioPrompt: string;
    outputPath: string;
    cachePath: string;
}

export function shouldSkipModel(model: string, cache: FailedModelsCache, forceAll: boolean): boolean {
    if (forceAll) return false;
    const entry = cache[model];
    if (!entry) return false;
    return entry.lastPassedAt === null;
}

export function partitionModels(
    models: readonly string[],
    cache: FailedModelsCache,
    forceAll: boolean,
): { toTest: string[]; skipped: SkippedModel[] } {
    const toTest: string[] = [];
    const skipped: SkippedModel[] = [];
    for (const model of models) {
        if (shouldSkipModel(model, cache, forceAll)) {
            const entry = cache[model];
            skipped.push({
                model,
                reason: "Previously unsupported (never passed)",
                lastTested: entry.lastTested,
                lastError: entry.error,
            });
        } else {
            toTest.push(model);
        }
    }
    return { toTest, skipped };
}

export function updateCacheAfterRun(
    results: readonly ModelResult[],
    skipped: readonly SkippedModel[],
    previousCache: FailedModelsCache,
    now: string,
): FailedModelsCache {
    const updated: FailedModelsCache = {};

    for (const entry of skipped) {
        if (previousCache[entry.model]) {
            updated[entry.model] = previousCache[entry.model];
        }
    }

    for (const result of results) {
        if (result.status === "pass") continue;
        const previous = previousCache[result.model];
        updated[result.model] = {
            lastTested: now,
            lastPassedAt: previous?.lastPassedAt ?? null,
            error: result.error ?? "HTTP failure",
            consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
        };
    }

    return updated;
}

interface CliOptions {
    forceAll: boolean;
    explicitModels: string[];
    scenarioPrompt: string;
    showHelp: boolean;
    outputPath: string;
    cachePath: string;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
    const options: CliOptions = {
        forceAll: false,
        explicitModels: [],
        scenarioPrompt: DEFAULT_SCENARIO_PROMPT,
        showHelp: false,
        outputPath: RESULTS_PATH,
        cachePath: CACHE_PATH,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h") {
            options.showHelp = true;
        } else if (arg === "--all") {
            options.forceAll = true;
        } else if (arg === "--model" && i + 1 < argv.length) {
            options.explicitModels.push(argv[++i]);
        } else if (arg === "--scenario" && i + 1 < argv.length) {
            options.scenarioPrompt = argv[++i];
        } else if (arg === "--output" && i + 1 < argv.length) {
            options.outputPath = resolve(argv[++i]);
        }
    }
    return options;
}

export function printUsage(): void {
    console.log(`Usage: bun scripts/smoke/test-models.ts [options]

Runs a minimal-hi smoke test against each model and records failures in
manifests/smoke/failed-models.json. On re-run, models that have never
passed are SKIPPED unless --all is passed.

Options:
  --all               Test every model regardless of prior-failure cache.
  --model <id>        Test only this model. Can be repeated.
  --scenario <text>   Override the default prompt ("${DEFAULT_SCENARIO_PROMPT}").
  --output <path>     Write results summary to this path
                      (default: ${RESULTS_PATH}).
  --help, -h          Show this help.

Default models: ${DEFAULT_MODELS.join(", ")}
With --all:     ${ALL_MODELS.join(", ")}

Requires a valid OAuth access token in ${ACCOUNTS_PATH} or
ANTHROPIC_OAUTH_ACCESS_TOKEN env var.
`);
}

function loadCache(cachePath: string): FailedModelsCache {
    if (!existsSync(cachePath)) return {};
    try {
        return JSON.parse(readFileSync(cachePath, "utf8")) as FailedModelsCache;
    } catch {
        return {};
    }
}

function resolveAccessToken(): string {
    const fromEnv = process.env.ANTHROPIC_OAUTH_ACCESS_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    if (!existsSync(ACCOUNTS_PATH)) {
        throw new Error(
            `No ANTHROPIC_OAUTH_ACCESS_TOKEN env var and no accounts file at ${ACCOUNTS_PATH}. Run 'opencode-anthropic-auth login' first.`,
        );
    }
    const raw = readFileSync(ACCOUNTS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { accounts?: Array<{ access?: string; expires?: number }> };
    const first = parsed.accounts?.[0];
    if (!first?.access) {
        throw new Error(`No cached access token in ${ACCOUNTS_PATH}. Run 'opencode-anthropic-auth refresh 1'.`);
    }
    if (first.expires && first.expires < Date.now()) {
        throw new Error(
            `Cached access token expired at ${new Date(first.expires).toISOString()}. Run 'opencode-anthropic-auth refresh 1'.`,
        );
    }
    return first.access;
}

async function testModel(modelId: string, accessToken: string, prompt: string): Promise<ModelResult> {
    const start = Date.now();
    const body = JSON.stringify({
        model: modelId,
        max_tokens: 128,
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: "user", content: prompt }],
    });
    try {
        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                authorization: `Bearer ${accessToken}`,
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
                "user-agent": "claude-cli/2.1.113 (external, sdk-cli)",
                "x-app": "cli",
            },
            body,
        });
        const timeMs = Date.now() - start;
        if (response.ok) {
            return { model: modelId, status: "pass", timeMs, error: null };
        }
        let errorMessage = `HTTP ${response.status}`;
        try {
            const errorBody = await response.text();
            const parsed = JSON.parse(errorBody) as { error?: { message?: string } };
            if (parsed.error?.message) errorMessage = parsed.error.message;
        } catch {
            errorMessage = `HTTP ${response.status}`;
        }
        return { model: modelId, status: "fail", timeMs, error: errorMessage };
    } catch (error) {
        const timeMs = Date.now() - start;
        return {
            model: modelId,
            status: "fail",
            timeMs,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function writeResults(
    results: readonly ModelResult[],
    skipped: readonly SkippedModel[],
    outputPath: string,
    version: string,
): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const output = {
        version,
        date: new Date().toISOString(),
        summary: { tested: results.length, passed, failed, skipped: skipped.length },
        results: results.map((r) => ({ model: r.model, status: r.status, timeMs: r.timeMs, error: r.error })),
        skipped,
    };
    writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

function writeCache(cache: FailedModelsCache, cachePath: string): void {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.showHelp) {
        printUsage();
        return;
    }

    const modelsToRun =
        options.explicitModels.length > 0 ? options.explicitModels : options.forceAll ? ALL_MODELS : DEFAULT_MODELS;

    const cache = loadCache(options.cachePath);
    const { toTest, skipped } = partitionModels(
        modelsToRun,
        cache,
        options.forceAll || options.explicitModels.length > 0,
    );

    console.log(`Smoke-testing ${toTest.length} model(s), skipping ${skipped.length} (cached failures).`);

    const accessToken = resolveAccessToken();
    const results: ModelResult[] = [];
    for (const model of toTest) {
        const result = await testModel(model, accessToken, options.scenarioPrompt);
        const icon = result.status === "pass" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
        const time = `${(result.timeMs / 1000).toFixed(1)}s`;
        console.log(`  ${icon} ${model.padEnd(35)} ${time}${result.error ? `  \x1b[31m${result.error}\x1b[0m` : ""}`);
        results.push(result);
    }

    const now = new Date().toISOString();
    const updatedCache = updateCacheAfterRun(results, skipped, cache, now);
    writeCache(updatedCache, options.cachePath);

    const pkgPath = resolve(REPO_ROOT, "package.json");
    const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
    writeResults(results, skipped, options.outputPath, version);

    const passed = results.filter((r) => r.status === "pass").length;
    console.log(`\nSummary: ${passed}/${results.length} passed`);
    if (skipped.length > 0) {
        console.log(`         ${skipped.length} skipped (cached failures)`);
    }
    console.log(`Results: ${options.outputPath}`);
    console.log(`Cache:   ${options.cachePath}`);
    if (passed < results.length) process.exit(1);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
