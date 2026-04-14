#!/usr/bin/env bun

/**
 * Bundle the plugin/CLI JS artifacts and optionally compile standalone CLI binaries.
 *
 *   dist/opencode-anthropic-auth-plugin.js          — plugin ESM bundle
 *   dist/opencode-anthropic-auth-cli.mjs            — CLI ESM bundle
 *   dist/opencode-anthropic-auth-<target>[.exe]     — standalone CLI binaries
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { build, type BuildOptions } from "esbuild";

import {
    CLI_BUNDLE_OUTFILE,
    CLI_BINARY_TARGETS,
    CLI_ENTRYPOINT,
    DIST_DIR,
    PLUGIN_OUTFILE,
    type CliBinaryTarget,
    getCliBinaryBuildArgs,
    getCliBinaryOutfile,
    parseBuildArguments,
} from "./build-config";

const shared: BuildOptions = {
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    // Node builtins stay as imports
    external: ["node:*"],
};

const options = parseBuildArguments(process.argv.slice(2));

await mkdir(DIST_DIR, { recursive: true });
await bundleJavaScriptArtifacts();

if (options.buildCliBinaries) {
    for (const target of options.cliBinaryTargets) {
        const args = getCliBinaryBuildArgs(target);
        console.log(`Compiling ${target.id} -> ${getCliBinaryOutfile(target)}`);
        await run("bun", args);
        await repairMacOSBinary(target);
    }

    const compiledTargets = options.cliBinaryTargets.map(({ id }) => id).join(", ");
    console.log(`Built ${options.cliBinaryTargets.length} standalone CLI binaries: ${compiledTargets}`);
} else {
    console.log(`Built ${PLUGIN_OUTFILE} and ${CLI_BUNDLE_OUTFILE}`);
    console.log(`Run with --cli-binaries to compile standalone CLI binaries for ${CLI_BINARY_TARGETS.length} targets.`);
}

async function bundleJavaScriptArtifacts() {
    await Promise.all([
        build({
            ...shared,
            entryPoints: ["src/index.ts"],
            outfile: PLUGIN_OUTFILE,
        }),
        build({
            ...shared,
            entryPoints: [CLI_ENTRYPOINT],
            outfile: CLI_BUNDLE_OUTFILE,
        }),
    ]);
}

async function repairMacOSBinary(target: CliBinaryTarget) {
    if (process.platform !== "darwin" || target.platform !== "darwin") {
        return;
    }

    const binaryPath = getCliBinaryOutfile(target);

    // Bun 1.3.12 can emit malformed Mach-O signatures on macOS when using
    // --compile; stripping and re-signing ad hoc repairs the binary locally.
    await run("codesign", ["--remove-signature", binaryPath]).catch(() => undefined);
    await run("codesign", ["--force", "--sign", "-", binaryPath]);
    console.log(`Re-signed ${target.id} for local macOS execution`);
}

function run(command: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: "inherit",
        });

        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
        });
    });
}
