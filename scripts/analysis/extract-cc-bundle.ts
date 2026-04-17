#!/usr/bin/env bun
/**
 * extract-cc-bundle.ts — Download & extract CC to produce a JS source file.
 *
 * For CC <2.1.113: extracts cli.js from the npm tarball directly.
 * For CC >=2.1.113: the main package is a 132KB shim with no cli.js. The real
 *   binary lives in per-platform packages (@anthropic-ai/claude-code-<platform>).
 *   We download that package, extract the Bun-compiled native binary, and run
 *   `strings` to pull the embedded JS source out as a cli.js-equivalent text file.
 *   The same downstream regex pipeline (extract-fingerprint.ts) then works
 *   unchanged because the JS source is stored verbatim in the binary.
 *
 * Usage: bun scripts/analysis/extract-cc-bundle.ts [version] [--output ./extracted]
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProgress } from "../lib/progress.ts";

const REGISTRY_BASE = "https://registry.npmjs.org/@anthropic-ai/claude-code";
const NATIVE_BINARY_MIN_VERSION = "2.1.113";

function isVersionAtLeast(version: string, minVersion: string): boolean {
    const a = version.split(".").map(Number);
    const b = minVersion.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
        if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
    }
    return true;
}

function resolvePlatformPackage(): string {
    const plat = platform();
    const cpu = arch();
    if (plat === "darwin" && cpu === "arm64") return `${REGISTRY_BASE}-darwin-arm64`;
    if (plat === "darwin" && cpu === "x64") return `${REGISTRY_BASE}-darwin-x64`;
    if (plat === "linux" && cpu === "arm64") return `${REGISTRY_BASE}-linux-arm64`;
    if (plat === "linux" && cpu === "x64") return `${REGISTRY_BASE}-linux-x64`;
    if (plat === "win32" && cpu === "x64") return `${REGISTRY_BASE}-win32-x64`;
    if (plat === "win32" && cpu === "arm64") return `${REGISTRY_BASE}-win32-arm64`;
    throw new Error(`Unsupported platform for CC native-binary extraction: ${plat}-${cpu}`);
}

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

async function downloadTarballFromUrl(
    url: string,
    destPath: string,
    onProgress: (received: number, total: number | null) => void,
): Promise<void> {
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

function findNativeBinary(dir: string): string | null {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findNativeBinary(fullPath);
            if (found) return found;
        } else if (entry.name === "claude" || entry.name === "claude.exe") {
            return fullPath;
        }
    }
    return null;
}

async function extractNativeBinaryToJs(
    version: string,
    outputDir: string,
    progress: ReturnType<typeof createProgress>,
    tmpDir: string,
): Promise<{ outputPath: string; size: number }> {
    const platformPkgBase = resolvePlatformPackage();
    const platformPkgName = platformPkgBase.substring(platformPkgBase.lastIndexOf("/") + 1);
    const platformTarballUrl = `${platformPkgBase}/-/${platformPkgName}-${version}.tgz`;

    progress.startStep("download platform package", `${platformPkgName}@${version}`);
    const platformTarballPath = join(tmpDir, `${platformPkgName}-${version}.tgz`);
    await downloadTarballFromUrl(platformTarballUrl, platformTarballPath, (received, total) => {
        progress.setBytes(received, total ?? undefined);
    });
    progress.finishStep();

    progress.startStep("extract platform tarball");
    const platformExtractDir = join(tmpDir, "platform-extracted");
    mkdirSync(platformExtractDir, { recursive: true });
    execFileSync("tar", ["xzf", platformTarballPath, "-C", platformExtractDir], { stdio: "pipe" });
    progress.finishStep();

    progress.startStep("locate native binary");
    const binaryPath = findNativeBinary(platformExtractDir);
    if (!binaryPath) {
        progress.fail("native claude binary not found in platform package");
        throw new Error("native claude binary not found in platform package");
    }
    progress.finishStep();

    progress.startStep("extract JS via `strings`");
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, `cli-${version}.js`);
    const stringsOutput = execFileSync("strings", ["-n", "10", binaryPath], { maxBuffer: 512 * 1024 * 1024 });
    writeFileSync(outputPath, stringsOutput);
    const size = statSync(outputPath).size;
    progress.finishStep(`${(size / (1024 * 1024)).toFixed(2)}MB`);

    return { outputPath, size };
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

    const useNativeBinary = isVersionAtLeast(version, NATIVE_BINARY_MIN_VERSION);

    try {
        let outputPath: string;
        let size: number;

        if (useNativeBinary) {
            const result = await extractNativeBinaryToJs(version, outputDir, progress, tmpDir);
            outputPath = result.outputPath;
            size = result.size;
        } else {
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
            outputPath = join(outputDir, `cli-${version}.js`);
            copyFileSync(cliJsPath, outputPath);
            size = statSync(outputPath).size;
            progress.finishStep(`${(size / (1024 * 1024)).toFixed(2)}MB`);
        }

        progress.done(`✓ extracted cli-${version}.js`);
        console.log(
            JSON.stringify(
                { version, path: outputPath, size, source: useNativeBinary ? "native-binary" : "cli.js" },
                null,
                2,
            ),
        );
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
