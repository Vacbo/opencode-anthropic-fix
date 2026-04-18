#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_TARGET_TOKENS = 180000;
const DEFAULT_OUTPUT = "scripts/verification/long-context-prompt.txt";
const CHARS_PER_TOKEN = 3.5;
const CHUNK = "The quick brown fox jumps over the lazy dog. ";

function parseArgs(args: string[]): { targetTokens: number; output: string } {
    let targetTokens = DEFAULT_TARGET_TOKENS;
    let output = DEFAULT_OUTPUT;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--target-tokens" && i + 1 < args.length) {
            const parsed = Number.parseInt(args[++i] ?? "", 10);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error("--target-tokens must be a positive integer");
            }
            targetTokens = parsed;
            continue;
        }
        if (arg === "--output" && i + 1 < args.length) {
            output = args[++i] ?? DEFAULT_OUTPUT;
            continue;
        }
    }

    return { targetTokens, output: resolve(output) };
}

function buildPrompt(targetTokens: number): string {
    const targetChars = Math.ceil(targetTokens * CHARS_PER_TOKEN);
    const repeated = CHUNK.repeat(Math.ceil(targetChars / CHUNK.length)).slice(0, targetChars);
    return [
        "You are reviewing the following document.",
        'Count the number of times the word "fox" appears.',
        "Return only the number and one short sentence explaining how you counted.",
        "",
        "Document:",
        repeated,
    ].join("\n\n");
}

function main(): void {
    const { targetTokens, output } = parseArgs(process.argv.slice(2));
    const prompt = buildPrompt(targetTokens);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, prompt);
    console.log(JSON.stringify({ output, targetTokens, chars: prompt.length }, null, 2));
}

main();
