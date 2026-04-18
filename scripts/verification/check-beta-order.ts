#!/usr/bin/env bun

import { readFileSync } from "node:fs";

interface Capture {
    headers?: Record<string, string>;
}

function parseArgs(argv: string[]): { ogPath: string; pluginPath: string } {
    let ogPath = "";
    let pluginPath = "";
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--og" && i + 1 < argv.length) {
            ogPath = argv[++i];
        } else if (arg === "--plugin" && i + 1 < argv.length) {
            pluginPath = argv[++i];
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
    }
    if (!ogPath || !pluginPath) {
        printUsage();
        process.exit(1);
    }
    return { ogPath, pluginPath };
}

function printUsage(): void {
    console.log(`Usage: bun scripts/verification/check-beta-order.ts --og <path> --plugin <path>

Extracts 'anthropic-beta' from two capture JSONs and asserts they are equal
by content AND order. Exits 0 on match, 1 on mismatch with a unified-diff.
`);
}

function extractBetas(capturePath: string): string[] {
    const raw = readFileSync(capturePath, "utf8");
    const capture = JSON.parse(raw) as Capture;
    const header = capture.headers?.["anthropic-beta"];
    if (!header) {
        throw new Error(`No 'anthropic-beta' header in ${capturePath}`);
    }
    return header
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean);
}

function printDiff(ogBetas: string[], pluginBetas: string[]): void {
    const maxLen = Math.max(ogBetas.length, pluginBetas.length);
    console.error("  Position | OG                                     | Plugin");
    console.error("  ---------+----------------------------------------+----------------------------------------");
    for (let i = 0; i < maxLen; i += 1) {
        const og = ogBetas[i] ?? "(none)";
        const plugin = pluginBetas[i] ?? "(none)";
        const marker = og === plugin ? " " : "*";
        console.error(`  ${marker}${String(i).padStart(7)} | ${og.padEnd(38)} | ${plugin}`);
    }
}

function main(): void {
    const { ogPath, pluginPath } = parseArgs(process.argv.slice(2));

    let ogBetas: string[];
    let pluginBetas: string[];
    try {
        ogBetas = extractBetas(ogPath);
        pluginBetas = extractBetas(pluginPath);
    } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(2);
    }

    if (ogBetas.length !== pluginBetas.length) {
        console.error(`MEMBERSHIP MISMATCH: OG has ${ogBetas.length} betas, plugin has ${pluginBetas.length}`);
        printDiff(ogBetas, pluginBetas);
        process.exit(1);
    }

    for (let i = 0; i < ogBetas.length; i += 1) {
        if (ogBetas[i] !== pluginBetas[i]) {
            console.error(`ORDER MISMATCH at position ${i}: OG='${ogBetas[i]}' plugin='${pluginBetas[i]}'`);
            printDiff(ogBetas, pluginBetas);
            process.exit(1);
        }
    }

    console.log(`MATCH: ${ogBetas.length} betas in identical order`);
    console.log(`  ${ogBetas.join(",")}`);
    process.exit(0);
}

main();
