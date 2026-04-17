#!/usr/bin/env bun
/**
 * Writes per-model capability JSON to `manifests/capabilities/<model>-<date>.json`.
 *
 * Uses Anthropic's `/v1/models/{id}` beta endpoint. Zero inference tokens.
 *
 * Env overrides: ANTHROPIC_OAUTH_ACCESS_TOKEN, CAPABILITY_MODELS, CAPABILITY_OUT_DIR.
 *
 * Context: `.sisyphus/notepads/phase-0-decisions.md` §7.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, "manifests/capabilities");
const ACCOUNTS_PATH = resolve(homedir(), ".config/opencode/anthropic-accounts.json");

const DEFAULT_MODELS = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"];

// Matches our plugin's runtime fingerprint; /v1/messages rejects stripped headers with 429.
const PLUGIN_USER_AGENT = "claude-cli/2.1.112 (external, sdk-cli)";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

interface AccountMetadata {
    access?: string;
    expires?: number;
}

interface AccountStorage {
    accounts: AccountMetadata[];
}

function resolveAccessToken(): string {
    const fromEnv = process.env.ANTHROPIC_OAUTH_ACCESS_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    if (!existsSync(ACCOUNTS_PATH)) {
        throw new Error(
            `No ANTHROPIC_OAUTH_ACCESS_TOKEN env var and no accounts file at ${ACCOUNTS_PATH}. ` +
                `Run 'opencode-anthropic-auth login' first, or pass the token via env.`,
        );
    }

    const raw = readFileSync(ACCOUNTS_PATH, "utf8");
    let parsed: AccountStorage;
    try {
        parsed = JSON.parse(raw) as AccountStorage;
    } catch (err) {
        throw new Error(`Failed to parse ${ACCOUNTS_PATH}: ${String(err)}`);
    }

    const firstAccount = parsed.accounts?.[0];
    if (!firstAccount?.access) {
        throw new Error(
            `No cached access token in ${ACCOUNTS_PATH}. ` + `Run 'opencode-anthropic-auth refresh 1' to populate one.`,
        );
    }

    const now = Date.now();
    if (firstAccount.expires && firstAccount.expires < now) {
        throw new Error(
            `Cached access token expired at ${new Date(firstAccount.expires).toISOString()}. ` +
                `Run 'opencode-anthropic-auth refresh 1'.`,
        );
    }

    return firstAccount.access;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

async function fetchCapabilities(modelId: string, accessToken: string): Promise<unknown> {
    const url = `https://api.anthropic.com/v1/models/${modelId}`;
    const response = await fetch(url, {
        headers: {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": OAUTH_BETA_HEADER,
            "anthropic-version": "2023-06-01",
            "user-agent": PLUGIN_USER_AGENT,
            "x-app": "cli",
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}\n${body.slice(0, 500)}`);
    }

    return (await response.json()) as unknown;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const outDir = process.env.CAPABILITY_OUT_DIR?.trim() || DEFAULT_OUT_DIR;
    const modelsEnv = process.env.CAPABILITY_MODELS?.trim();
    const models = modelsEnv
        ? modelsEnv
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
        : DEFAULT_MODELS;

    if (models.length === 0) {
        throw new Error("No models specified. Set CAPABILITY_MODELS env var or use the default list.");
    }

    mkdirSync(outDir, { recursive: true });
    const accessToken = resolveAccessToken();
    const date = new Date().toISOString().slice(0, 10);

    const results: { model: string; outPath: string; thinking: unknown; effort: unknown }[] = [];

    for (const model of models) {
        process.stderr.write(`Fetching capabilities for ${model}...\n`);
        const data = await fetchCapabilities(model, accessToken);

        const outPath = resolve(outDir, `${model}-${date}.json`);
        writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`);

        const caps = (data as { capabilities?: { thinking?: unknown; effort?: unknown } }).capabilities;
        results.push({
            model,
            outPath,
            thinking: caps?.thinking,
            effort: caps?.effort,
        });

        process.stderr.write(`  -> ${outPath}\n`);
    }

    // Summary for the operator
    process.stdout.write("\n=== Capability snapshot summary ===\n");
    for (const r of results) {
        process.stdout.write(`\n${r.model}\n  file: ${r.outPath}\n`);
        if (r.thinking) {
            process.stdout.write(`  thinking: ${JSON.stringify(r.thinking)}\n`);
        }
        if (r.effort) {
            process.stdout.write(`  effort:   ${JSON.stringify(r.effort)}\n`);
        }
    }
    process.stdout.write(`\nWrote ${results.length} snapshot(s) to ${outDir}\n`);
}

main().catch((err) => {
    process.stderr.write(`\n[snapshot.ts] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
