#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { getCliBinaryOutfile, parseCliBinaryTargetArgs, resolveCliBinaryTargets } from "./build-config";

const requestedTargetIds = parseCliBinaryTargetArgs(process.argv.slice(2));
const targets = resolveCliBinaryTargets(requestedTargetIds);

if (targets.length === 0) {
    throw new Error("No CLI binary targets resolved for smoke test.");
}

for (const target of targets) {
    const binaryPath = resolve(getCliBinaryOutfile(target));

    await run(binaryPath, ["--help"]);
    console.log(`Smoke test passed: ${binaryPath} --help`);
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
