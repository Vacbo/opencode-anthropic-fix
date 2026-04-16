#!/usr/bin/env bun
/**
 * extract-cc-bundle.ts — Download & extract CC npm package to get cli.js
 * Usage: bun scripts/analysis/extract-cc-bundle.ts [version] [--output ./extracted]
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProgress } from "../lib/progress.ts";

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

async function downloadTarball(
    version: string,
    destPath: string,
    onProgress: (received: number, total: number | null) => void,
): Promise<void> {
    const url = `${REGISTRY_BASE}/-/claude-code-${version}.tgz`;
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to download tarball: ${resp.status} ${resp.statusText} (${url})`);
    }
    const contentLength = resp.headers.get("content-length");
    const total = contentLength ? Number(contentLength) : null;
    if (!resp.body) {
        const buffer = await resp.arrayBuffer();
        writeFileSync(destPath, new Uint8Array(buffer));
        onProgress(buffer.byteLength, total);
        return;
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.byteLength;
            onProgress(received, total);
        }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    writeFileSync(destPath, merged);
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
    const progress = createProgress();

    progress.startStep("resolve version", requestedVersion);
    const version = await resolveVersion(requestedVersion);
    progress.finishStep(version);

    const tmpDir = join(tmpdir(), `cc-extract-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
        const tarballPath = join(tmpDir, `claude-code-${version}.tgz`);
        progress.startStep("download tarball", version);
        await downloadTarball(version, tarballPath, (received, total) => {
            progress.setBytes(received, total ?? undefined);
        });
        progress.finishStep();

        progress.startStep("extract tarball");
        const extractDir = join(tmpDir, "extracted");
        mkdirSync(extractDir, { recursive: true });
        execFileSync("tar", ["xzf", tarballPath, "-C", extractDir], {
            stdio: "pipe",
        });
        progress.finishStep();

        progress.startStep("locate cli.js");
        const cliJsPath = findCliJs(extractDir);
        if (!cliJsPath) {
            progress.fail("cli.js not found in extracted package");
            throw new Error("cli.js not found in extracted package");
        }
        progress.finishStep();

        progress.startStep("copy to output");
        mkdirSync(outputDir, { recursive: true });
        const outputPath = join(outputDir, `cli-${version}.js`);
        copyFileSync(cliJsPath, outputPath);
        const size = statSync(outputPath).size;
        progress.finishStep(`${(size / (1024 * 1024)).toFixed(2)}MB`);

        progress.done(`✓ extracted cli-${version}.js`);
        console.log(JSON.stringify({ version, path: outputPath, size }, null, 2));
    } catch (err) {
        progress.fail(err instanceof Error ? err.message : String(err));
        throw err;
    } finally {
        if (existsSync(tmpDir)) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}

main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
