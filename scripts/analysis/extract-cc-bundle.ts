#!/usr/bin/env bun
/**
 * extract-cc-bundle.ts — Download & extract CC npm package to get cli.js
 * Usage: bun scripts/analysis/extract-cc-bundle.ts [version] [--output ./extracted]
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REGISTRY_BASE = "https://registry.npmjs.org/@anthropic-ai/claude-code";

function parseArgs(args: string[]): { version: string; outputDir: string } {
  let version = "latest";
  let outputDir = "./extracted";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output" && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (!arg.startsWith("--")) {
      version = arg;
    }
  }

  return { version, outputDir: resolve(outputDir) };
}

async function resolveVersion(version: string): Promise<string> {
  if (version === "latest") {
    const resp = await fetch(REGISTRY_BASE);
    if (!resp.ok) {
      throw new Error(`Failed to fetch registry metadata: ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as { "dist-tags": Record<string, string> };
    const latest = data["dist-tags"].latest;
    if (!latest) {
      throw new Error("Could not determine latest version from registry");
    }
    return latest;
  }
  return version;
}

async function downloadTarball(version: string, destPath: string): Promise<void> {
  const url = `${REGISTRY_BASE}/-/claude-code-${version}.tgz`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download tarball: ${resp.status} ${resp.statusText} (${url})`);
  }
  const buffer = await resp.arrayBuffer();
  await Bun.write(destPath, buffer);
}

function findCliJs(dir: string): string | null {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCliJs(fullPath);
      if (found) return found;
    } else if (entry.name === "cli.js") {
      return fullPath;
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const { version: requestedVersion, outputDir } = parseArgs(args);

  const version = await resolveVersion(requestedVersion);
  console.error(`Resolved version: ${version}`);

  // Create temp dir for download and extraction
  const tmpDir = join(tmpdir(), `cc-extract-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    // Download tarball
    const tarballPath = join(tmpDir, `claude-code-${version}.tgz`);
    console.error(`Downloading tarball...`);
    await downloadTarball(version, tarballPath);

    // Extract tarball using execFileSync (no shell injection risk)
    const extractDir = join(tmpDir, "extracted");
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["xzf", tarballPath, "-C", extractDir], {
      stdio: "pipe",
    });

    // Find cli.js
    const cliJsPath = findCliJs(extractDir);
    if (!cliJsPath) {
      throw new Error("cli.js not found in extracted package");
    }

    // Copy to output dir
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `cli-${version}.js`);
    copyFileSync(cliJsPath, outputPath);

    const size = statSync(outputPath).size;

    // Print result as JSON to stdout
    console.log(JSON.stringify({ version, path: outputPath, size }, null, 2));
  } finally {
    // Clean up temp dir
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
