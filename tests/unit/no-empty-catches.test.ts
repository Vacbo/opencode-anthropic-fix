import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(currentFilePath), "..", "..");
const SRC_DIR = join(PROJECT_ROOT, "src");

const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/gm;

function collectTsFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stats = statSync(full);
        if (stats.isDirectory()) {
            collectTsFiles(full, acc);
        } else if (stats.isFile() && full.endsWith(".ts")) {
            acc.push(full);
        }
    }
    return acc;
}

describe("no empty catch blocks in src/", () => {
    it("rejects catch(e) {} and catch {} across src/**/*.ts", () => {
        const tsFiles = collectTsFiles(SRC_DIR);
        const offenders: string[] = [];
        for (const file of tsFiles) {
            const contents = readFileSync(file, "utf8");
            const matches = contents.matchAll(EMPTY_CATCH_RE);
            for (const match of matches) {
                const before = contents.slice(0, match.index);
                const line = before.split("\n").length;
                offenders.push(`${file.replace(`${PROJECT_ROOT}/`, "")}:${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
