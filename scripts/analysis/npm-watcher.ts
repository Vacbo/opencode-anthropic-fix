#!/usr/bin/env bun
/**
 * npm-watcher.ts — Watch for new CC releases on npm
 * Usage: bun scripts/analysis/npm-watcher.ts [--interval 15m] [--once]
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRY_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const STATE_FILE = resolve(import.meta.dir, ".npm-watcher-state.json");

interface WatcherState {
  lastVersion: string | null;
  lastCheck: string;
}

function parseArgs(argv: string[]): { intervalMs: number; once: boolean } {
  let intervalMs = 15 * 60 * 1000; // 15 minutes
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--once") {
      once = true;
    } else if (argv[i] === "--interval" && argv[i + 1]) {
      const raw = argv[i + 1];
      const match = raw.match(/^(\d+)(s|m|h)$/);
      if (!match) {
        console.error('Error: --interval must be in format like "5m", "1h", "30s"');
        process.exit(1);
      }
      const value = parseInt(match[1], 10);
      const unit = match[2];
      const multipliers: Record<string, number> = {
        s: 1000,
        m: 60_000,
        h: 3_600_000,
      };
      intervalMs = value * multipliers[unit];
      i++;
    }
  }

  return { intervalMs, once };
}

function loadState(): WatcherState {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return { lastVersion: null, lastCheck: "" };
}

function saveState(state: WatcherState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchLatestVersion(): Promise<string> {
  const resp = await fetch(REGISTRY_URL);
  if (!resp.ok) {
    throw new Error(`Registry fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as { "dist-tags": Record<string, string> };
  const latest = data["dist-tags"].latest;
  if (!latest) throw new Error("Could not determine latest version");
  return latest;
}

function run(cmd: string): string {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

async function processNewVersion(newVersion: string, prevVersion: string | null): Promise<void> {
  const scriptDir = import.meta.dir;

  // 1. Extract the bundle
  console.log(`\n[1/4] Extracting CC ${newVersion} bundle...`);
  run(`bun ${resolve(scriptDir, "extract-cc-bundle.ts")} ${newVersion} --output ./extracted`);

  const cliPath = resolve("./extracted", `cli-${newVersion}.js`);

  // 2. Extract fingerprint as JSON
  console.log(`\n[2/4] Extracting fingerprint...`);
  const fpJson = run(`bun ${resolve(scriptDir, "extract-fingerprint.ts")} ${cliPath} --version ${newVersion} --json`);
  const fpOutputPath = resolve("./extracted", `${newVersion}.json`);
  writeFileSync(fpOutputPath, fpJson);
  console.log(`  Wrote ${fpOutputPath}`);

  // 3. Generate markdown docs
  console.log(`\n[3/4] Generating markdown documentation...`);
  run(`bun ${resolve(scriptDir, "extract-fingerprint.ts")} ${cliPath} --version ${newVersion} --markdown`);

  // 4. Diff against previous version if available
  if (prevVersion) {
    const prevFpPath = resolve("./extracted", `${prevVersion}.json`);
    if (existsSync(prevFpPath)) {
      console.log(`\n[4/4] Diffing ${prevVersion} → ${newVersion}...`);
      run(`bun ${resolve(scriptDir, "diff-fingerprints.ts")} ${prevFpPath} ${fpOutputPath}`);
    } else {
      console.log(`\n[4/4] Skipping diff — no previous fingerprint at ${prevFpPath}`);
    }
  } else {
    console.log(`\n[4/4] Skipping diff — no previous version known`);
  }
}

async function checkOnce(): Promise<void> {
  const state = loadState();
  const now = new Date().toISOString();

  console.log(`[${now}] Checking npm for @anthropic-ai/claude-code...`);
  const latestVersion = await fetchLatestVersion();
  console.log(`  Latest version: ${latestVersion}`);
  console.log(`  Known version:  ${state.lastVersion ?? "(none)"}`);

  if (latestVersion === state.lastVersion) {
    console.log("  No new version detected.");
    saveState({ ...state, lastCheck: now });
    return;
  }

  console.log(`\n*** New version detected: ${state.lastVersion ?? "(none)"} → ${latestVersion} ***`);

  await processNewVersion(latestVersion, state.lastVersion);

  saveState({ lastVersion: latestVersion, lastCheck: now });
  console.log(`\nDone. State updated.`);
}

async function main(): Promise<void> {
  const { intervalMs, once } = parseArgs(process.argv.slice(2));

  if (once) {
    await checkOnce();
    return;
  }

  console.log(`npm-watcher: polling every ${intervalMs / 1000}s. Press Ctrl+C to stop.\n`);

  // Initial check
  await checkOnce();

  // Poll loop
  const poll = async () => {
    while (true) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        await checkOnce();
      } catch (err) {
        console.error(`Poll error: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  await poll();
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
