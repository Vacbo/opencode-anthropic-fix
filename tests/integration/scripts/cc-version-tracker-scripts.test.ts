import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = "/Users/vacbo/Documents/Projects/opencode-anthropic-fix";
const trackerScriptsDir = join(projectRoot, ".opencode", "skills", "cc-version-tracker", "scripts");
const extractScriptPath = join(trackerScriptsDir, "extract-fingerprint.mjs");
const compareScriptPath = join(trackerScriptsDir, "compare-versions.mjs");

function createFixture(version: string, cliContents: string) {
    const dir = mkdtempSync(join(tmpdir(), `cc-version-tracker-${version}-`));
    const cliPath = join(dir, "cli.js");
    const packageJsonPath = join(dir, "package.json");

    writeFileSync(packageJsonPath, JSON.stringify({ version }, null, 2));
    writeFileSync(cliPath, cliContents);

    return { dir, cliPath, packageJsonPath };
}

function runNodeScript(scriptPath: string, args: string[]) {
    return execFileSync(process.execPath, [scriptPath, ...args], {
        cwd: projectRoot,
        encoding: "utf8",
    });
}

function readJsonFile(path: string) {
    return JSON.parse(readFileSync(path, "utf8"));
}

const tempPathsToRemove = new Set<string>();

afterEach(() => {
    for (const path of tempPathsToRemove) {
        rmSync(path, { recursive: true, force: true });
    }

    tempPathsToRemove.clear();
});

describe("cc-version-tracker scripts", () => {
    it("extract-fingerprint resolves version from adjacent package.json and writes a versioned snapshot file", () => {
        const fixture = createFixture(
            "2.1.107",
            [
                'const data = ["oauth-2025-04-20", "managed-agents-2026-04-01"];',
                'const prod = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";',
                'const staging = "22422756-60c9-4084-8eb7-27705fd5cf9a";',
            ].join("\n"),
        );
        const outputPath = "/tmp/cc-fingerprint-2.1.107.json";

        tempPathsToRemove.add(fixture.dir);
        tempPathsToRemove.add(outputPath);

        const stdout = runNodeScript(extractScriptPath, [fixture.cliPath]);
        const parsed = JSON.parse(stdout);

        expect(parsed.version).toBe("2.1.107");
        expect(parsed.clientIds.prod).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
        expect(parsed.clientIds.staging).toBe("22422756-60c9-4084-8eb7-27705fd5cf9a");
        expect(existsSync(outputPath)).toBe(true);

        const written = readJsonFile(outputPath);
        expect(written.version).toBe("2.1.107");
    });

    it("compare-versions uses extracted versions and reports only real beta additions", () => {
        const oldFixture = createFixture(
            "2.1.98",
            ['const base = ["oauth-2025-04-20", "managed-agents-2026-04-01"];', 'const ua = "axios/1.13.6";'].join(
                "\n",
            ),
        );
        const newFixture = createFixture(
            "2.1.107",
            [
                'const base = ["oauth-2025-04-20", "managed-agents-2026-04-01", "new-beta-2026-04-14"];',
                'const ua = "axios/1.13.6";',
            ].join("\n"),
        );

        tempPathsToRemove.add(oldFixture.dir);
        tempPathsToRemove.add(newFixture.dir);
        tempPathsToRemove.add("/tmp/cc-fingerprint-2.1.98.json");
        tempPathsToRemove.add("/tmp/cc-fingerprint-2.1.107.json");

        const report = runNodeScript(compareScriptPath, [oldFixture.cliPath, newFixture.cliPath]);

        expect(report).toContain("# CC Fingerprint Diff: 2.1.98 -> 2.1.107");
        expect(report).toContain("`betas.always` — items added");
        expect(report).toContain("`new-beta-2026-04-14`");
        expect(report).not.toContain("`managed-agents-2026-04-01`");
    });
});
