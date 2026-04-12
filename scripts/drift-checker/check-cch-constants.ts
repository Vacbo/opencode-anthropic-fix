#!/usr/bin/env bun

/// <reference types="bun-types" />

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { scanCchConstants, type DriftScanReport } from "../../src/drift/cch-constants.js";

const REGISTRY_BASE = "https://registry.npmjs.org/@anthropic-ai/claude-code";

interface CliOptions {
  path?: string;
  version?: string;
  npmVersion?: string;
  json: boolean;
  failOnDrift: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    failOnDrift: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path" && argv[index + 1]) {
      options.path = resolve(argv[++index]);
    } else if (arg === "--version" && argv[index + 1]) {
      options.version = argv[++index];
    } else if (arg === "--npm-version" && argv[index + 1]) {
      options.npmVersion = argv[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-drift") {
      options.failOnDrift = true;
    }
  }

  return options;
}

async function resolveLatestStandaloneVersion(): Promise<string> {
  const root = resolve(process.env.HOME ?? "", ".local", "share", "claude", "versions");
  const entries = readdirSync(root, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isFile() && /^\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  const latest = versions[versions.length - 1];
  if (!latest) {
    throw new Error(`No Claude standalone binaries found in ${root}`);
  }
  return latest;
}

async function resolveLatestNpmVersion(): Promise<string> {
  const response = await fetch(REGISTRY_BASE);
  if (!response.ok) {
    throw new Error(`Failed to fetch registry metadata: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { "dist-tags": Record<string, string> };
  const latest = data["dist-tags"].latest;
  if (!latest) {
    throw new Error("Could not determine latest npm version from registry");
  }
  return latest;
}

async function downloadCliBundle(version: string): Promise<string> {
  const tarballUrl = `${REGISTRY_BASE}/-/claude-code-${version}.tgz`;
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(`Failed to download tarball: ${response.status} ${response.statusText} (${tarballUrl})`);
  }

  const tarballPath = join(tmpdir(), `claude-code-${version}-${Date.now()}.tgz`);
  writeFileSync(tarballPath, Buffer.from(await response.arrayBuffer()));

  const extractDir = join(tmpdir(), `claude-cli-${version}-extract-${Date.now()}`);
  mkdirSync(extractDir, { recursive: true });

  const cliOutputPath = join(tmpdir(), `claude-cli-${version}-${Date.now()}.js`);
  try {
    execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { stdio: "ignore" });
    const directCliPath = join(extractDir, "package", "cli.js");
    copyFileSync(directCliPath, cliOutputPath);
  } catch {
    const extracted = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const cliPathInTar = extracted.split("\n").find((entry) => entry.endsWith("/cli.js") || entry === "package/cli.js");
    if (!cliPathInTar) {
      throw new Error(`cli.js not found in npm tarball for ${version}`);
    }
    execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], { stdio: "ignore", maxBuffer: 64 * 1024 * 1024 });
    copyFileSync(join(extractDir, cliPathInTar), cliOutputPath);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
  return cliOutputPath;
}

function renderPretty(report: DriftScanReport): string {
  const lines: string[] = [];
  lines.push(`Target: ${report.target}`);
  lines.push(`Mode:   ${report.mode}`);
  lines.push(`Status: ${report.passed ? "PASS" : "DRIFT DETECTED"}`);
  lines.push("");
  lines.push(`placeholder matches: ${report.checked.placeholder}`);
  lines.push(`salt matches:        ${report.checked.salt}`);
  lines.push(`seed matches:        ${report.checked.seed}`);
  lines.push(`prime matches:       ${report.checked.primes.join(", ")}`);

  if (report.findings.length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const finding of report.findings) {
      lines.push(
        `- [${finding.severity}] ${finding.name}: expected ${finding.expected}, actual ${finding.actual} (matches=${finding.count})`,
      );
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let targetPath: string;
  let mode: "standalone" | "bundle";

  if (options.npmVersion) {
    const npmVersion = options.npmVersion === "latest" ? await resolveLatestNpmVersion() : options.npmVersion;
    targetPath = await downloadCliBundle(npmVersion);
    mode = "bundle";
  } else if (options.path) {
    targetPath = options.path;
    mode = targetPath.endsWith(".js") ? "bundle" : "standalone";
  } else {
    const version = options.version ?? (await resolveLatestStandaloneVersion());
    targetPath = resolve(process.env.HOME ?? "", ".local", "share", "claude", "versions", version);
    mode = "standalone";
  }

  await stat(targetPath);
  const bytes = new Uint8Array(await readFile(targetPath));
  const report = scanCchConstants(bytes, targetPath, mode);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderPretty(report));
  }

  if (options.failOnDrift && !report.passed) {
    process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
