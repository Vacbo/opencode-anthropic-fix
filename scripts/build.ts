#!/usr/bin/env bun

/**
 * Bundle the plugin/CLI JS artifacts and optionally compile standalone CLI binaries.
 *
 *   dist/opencode-anthropic-auth-plugin.mjs         — plugin ESM bundle
 *   dist/opencode-anthropic-auth-cli.mjs            — CLI ESM bundle
 *   dist/opencode-anthropic-auth-<target>[.exe]     — standalone CLI binaries
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";

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

const COMPILE_MAX_ATTEMPTS = 3;

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
        await compileCliBinary(target);
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

async function compileCliBinary(target: CliBinaryTarget): Promise<void> {
    const outfile = getCliBinaryOutfile(target);
    const args = getCliBinaryBuildArgs(target);

    for (let attempt = 1; attempt <= COMPILE_MAX_ATTEMPTS; attempt += 1) {
        console.log(
            `Compiling ${target.id} -> ${outfile}${attempt > 1 ? ` (retry ${attempt}/${COMPILE_MAX_ATTEMPTS})` : ""}`,
        );

        await rm(outfile, { force: true });

        try {
            await run("bun", args);
        } catch (error) {
            if (attempt === COMPILE_MAX_ATTEMPTS) throw error;
            console.warn(
                `bun compile failed for ${target.id}; retrying (${error instanceof Error ? error.message : error})`,
            );
            continue;
        }

        // Bun 1.3.12 can exit 0 for --compile without producing an output file
        // (observed on GitHub's ubuntu runners for musl cross-compile targets
        // and on the Bun CDN extract path for windows-x64-baseline). Verify
        // the file exists so we fail loudly instead of ENOENTing later.
        const exists = await stat(outfile).then(
            (info) => info.isFile() && info.size > 0,
            () => false,
        );

        if (exists) {
            await repairMacOSBinary(target);
            return;
        }

        if (attempt === COMPILE_MAX_ATTEMPTS) {
            throw new Error(
                `bun compile for ${target.id} exited 0 but did not produce ${outfile}. ` +
                    `This is a known Bun 1.3.12 issue with some cross-compile targets on CI runners.`,
            );
        }
        console.warn(`bun compile for ${target.id} produced no output; retrying`);
    }
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
