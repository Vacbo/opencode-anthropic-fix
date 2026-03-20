#!/usr/bin/env bun
/**
 * mitm-capture.ts — MITM proxy capture for api.anthropic.com traffic
 * Usage: bun scripts/analysis/mitm-capture.ts [--port 8080] [--output ./captures]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

function parseArgs(argv: string[]): { port: number; output: string } {
  let port = 8080;
  let output = "./captures";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error("Error: --port must be a valid port number (1-65535)");
        process.exit(1);
      }
      i++;
    } else if (argv[i] === "--output" && argv[i + 1]) {
      output = argv[i + 1];
      i++;
    }
  }

  return { port, output: resolve(output) };
}

function checkMitmproxy(): void {
  try {
    execFileSync("mitmdump", ["--version"], { stdio: "pipe" });
  } catch {
    console.error("Error: mitmproxy is not installed or not in PATH.");
    console.error("");
    console.error("Install mitmproxy:");
    console.error("  macOS:   brew install mitmproxy");
    console.error("  Linux:   pip install mitmproxy");
    console.error("  Windows: pip install mitmproxy");
    console.error("");
    console.error("See https://mitmproxy.org/ for more info.");
    process.exit(1);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  checkMitmproxy();

  if (!existsSync(args.output)) {
    mkdirSync(args.output, { recursive: true });
  }

  const addonPath = join(import.meta.dir, "mitm-addon.py");

  console.log(`Starting mitmproxy capture...`);
  console.log(`  Port:   ${args.port}`);
  console.log(`  Output: ${args.output}`);
  console.log(`  Addon:  ${addonPath}`);
  console.log(`\nPress Ctrl+C to stop.\n`);

  // Use spawnSync with inherited stdio — mitmdump handles its own
  // signal handling and Ctrl+C propagates naturally via the TTY.
  const result = spawnSync(
    "mitmdump",
    ["-p", String(args.port), "-s", addonPath, "--set", `output_dir=${args.output}`],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.error(`Failed to start mitmdump: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== null && result.status !== 0) {
    console.error(`mitmdump exited with code ${result.status}`);
    process.exit(result.status);
  }
}

main();
