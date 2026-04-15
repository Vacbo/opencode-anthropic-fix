#!/usr/bin/env node
/**
 * compare-versions.mjs — Diff fingerprints from two CC cli.js files
 *
 * Usage:
 *   node compare-versions.mjs /tmp/cc-2.1.79/cli.js /tmp/cc-2.1.80/cli.js
 *
 * Runs extract-fingerprint on both, then diffs the JSON outputs.
 */

import { execFileSync } from "child_process";
import { existsSync, realpathSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extractScript = join(__dirname, "extract-fingerprint.mjs");

const [oldCli, newCli] = process.argv.slice(2);
if (!oldCli || !newCli) {
    console.error("Usage: node compare-versions.mjs <old-cli.js> <new-cli.js>");
    process.exit(1);
}

for (const p of [oldCli, newCli]) {
    if (!existsSync(p)) {
        console.error(`File not found: ${p}`);
        process.exit(1);
    }
}

if (realpathSync(oldCli) === realpathSync(newCli)) {
    console.error("Refusing to compare the same cli.js file twice.");
    process.exit(1);
}

function inferVersionFromPath(cliPath) {
    const m = cliPath.match(/(?:^|[^\d])(\d+\.\d+\.\d+)(?:[^\d]|$)/);
    return m?.[1] || null;
}

function extractFingerprint(cliPath) {
    const inferredVersion = inferVersionFromPath(cliPath);
    const args = [extractScript, cliPath];
    if (inferredVersion) {
        args.push("--version", inferredVersion);
    }
    const raw = execFileSync(process.execPath, args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "inherit"],
    });
    const parsed = JSON.parse(raw);

    if (parsed.version === "unknown") {
        throw new Error(`Unable to resolve version for ${cliPath}`);
    }

    return parsed;
}

console.error("Extracting old fingerprint...");
const oldFp = extractFingerprint(oldCli);
console.error("Extracting new fingerprint...");
const newFp = extractFingerprint(newCli);

// Deep diff
function diff(oldVal, newVal, path = "") {
    const changes = [];

    if (typeof oldVal !== typeof newVal) {
        changes.push({ path, old: oldVal, new: newVal, type: "type-change" });
        return changes;
    }

    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        const added = newVal.filter((v) => !oldVal.includes(v));
        const removed = oldVal.filter((v) => !newVal.includes(v));
        if (added.length) changes.push({ path, type: "array-added", values: added });
        if (removed.length) changes.push({ path, type: "array-removed", values: removed });
        return changes;
    }

    if (typeof oldVal === "object" && oldVal !== null && newVal !== null) {
        const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
        for (const key of allKeys) {
            const subPath = path ? `${path}.${key}` : key;
            if (!(key in oldVal)) {
                changes.push({ path: subPath, type: "added", value: newVal[key] });
            } else if (!(key in newVal)) {
                changes.push({ path: subPath, type: "removed", value: oldVal[key] });
            } else {
                changes.push(...diff(oldVal[key], newVal[key], subPath));
            }
        }
        return changes;
    }

    if (oldVal !== newVal) {
        changes.push({ path, old: oldVal, new: newVal, type: "changed" });
    }
    return changes;
}

const changes = diff(oldFp, newFp);

// Output markdown report
const lines = [
    `# CC Fingerprint Diff: ${oldFp.version} -> ${newFp.version}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
];

if (changes.length === 0) {
    lines.push("No mimicry-relevant changes detected.");
} else {
    lines.push(`## ${changes.length} Change(s) Found`, "");
    for (const c of changes) {
        switch (c.type) {
            case "changed":
                lines.push(`### \`${c.path}\``);
                lines.push(`- **Old:** \`${JSON.stringify(c.old)}\``);
                lines.push(`- **New:** \`${JSON.stringify(c.new)}\``);
                lines.push("");
                break;
            case "added":
                lines.push(`### \`${c.path}\` (added)`);
                lines.push(`- **Value:** \`${JSON.stringify(c.value)}\``);
                lines.push("");
                break;
            case "removed":
                lines.push(`### \`${c.path}\` (removed)`);
                lines.push(`- **Value:** \`${JSON.stringify(c.value)}\``);
                lines.push("");
                break;
            case "array-added":
                lines.push(`### \`${c.path}\` — items added`);
                for (const v of c.values) lines.push(`- \`${v}\``);
                lines.push("");
                break;
            case "array-removed":
                lines.push(`### \`${c.path}\` — items removed`);
                for (const v of c.values) lines.push(`- \`${v}\``);
                lines.push("");
                break;
            case "type-change":
                lines.push(`### \`${c.path}\` (type changed)`);
                lines.push(`- **Old:** \`${JSON.stringify(c.old)}\``);
                lines.push(`- **New:** \`${JSON.stringify(c.new)}\``);
                lines.push("");
                break;
        }
    }
}

console.log(lines.join("\n"));
