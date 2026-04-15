#!/usr/bin/env bun
/**
 * diff-manifests.ts — Compare two candidate manifests and emit machine-readable reports.
 *
 * Usage:
 *   bun scripts/analysis/diff-manifests.ts <old-manifest.json> <new-manifest.json> [--json-output <path>] [--markdown-output <path>]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { classifyRisk, validateCandidateManifest } from "../../src/fingerprint/schema.ts";
import type { CandidateManifest, FieldRisk } from "../../src/fingerprint/types.ts";

type ChangeKind = "added" | "removed" | "changed" | "type-changed";

const IGNORED_PATHS = new Set(["source.extractionTimestamp"]);

export interface ManifestDiffChange {
    path: string;
    kind: ChangeKind;
    severity: FieldRisk;
    oldValue?: unknown;
    newValue?: unknown;
}

export interface ManifestDiffReport {
    generatedAt: string;
    oldManifestPath: string;
    newManifestPath: string;
    oldVersion: string;
    newVersion: string;
    changes: ManifestDiffChange[];
    summary: {
        total: number;
        critical: number;
        sensitive: number;
        lowRisk: number;
    };
}

interface ParsedArgs {
    oldManifestPath: string;
    newManifestPath: string;
    jsonOutputPath?: string;
    markdownOutputPath?: string;
    help: boolean;
}

function printUsage(): void {
    console.log(`Usage: bun scripts/analysis/diff-manifests.ts <old-manifest.json> <new-manifest.json> [--json-output <path>] [--markdown-output <path>]

Arguments:
  <old-manifest.json>       Existing candidate manifest path
  <new-manifest.json>       Newly generated candidate manifest path

Options:
  --json-output <path>      Output path for the JSON diff report
  --markdown-output <path>  Output path for the markdown summary
  --help                    Show this help message
`);
}

function parseArgs(args: string[]): ParsedArgs {
    let oldManifestPath = "";
    let newManifestPath = "";
    let jsonOutputPath: string | undefined;
    let markdownOutputPath: string | undefined;
    let help = false;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help") {
            help = true;
        } else if (arg === "--json-output" && index + 1 < args.length) {
            jsonOutputPath = resolve(args[index + 1]);
            index += 1;
        } else if (arg === "--markdown-output" && index + 1 < args.length) {
            markdownOutputPath = resolve(args[index + 1]);
            index += 1;
        } else if (!arg.startsWith("--") && !oldManifestPath) {
            oldManifestPath = resolve(arg);
        } else if (!arg.startsWith("--") && !newManifestPath) {
            newManifestPath = resolve(arg);
        }
    }

    if (!help && (!oldManifestPath || !newManifestPath)) {
        throw new Error("diff-manifests requires <old-manifest.json> and <new-manifest.json>");
    }

    return {
        oldManifestPath,
        newManifestPath,
        jsonOutputPath,
        markdownOutputPath,
        help,
    };
}

function readJsonFile<T>(filePath: string): T {
    try {
        return JSON.parse(readFileSync(filePath, "utf8")) as T;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read JSON from ${filePath}: ${message}`);
    }
}

function normalizeRiskPath(path: string): string | null {
    const segments = path.split(".");
    if (segments.length < 2) {
        return null;
    }

    const roots = new Set(["transport", "headers", "betas", "billing", "body", "prompt", "metadata"]);
    if (!roots.has(segments[0])) {
        return null;
    }

    return `${segments[0]}.${segments[1]}`;
}

function severityForPath(path: string): FieldRisk {
    const riskPath = normalizeRiskPath(path);
    return riskPath ? classifyRisk(riskPath) : "low-risk";
}

function shouldIgnorePath(path: string): boolean {
    if (!path) {
        return false;
    }

    return IGNORED_PATHS.has(path) || path.endsWith(".extractedAt");
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return JSON.stringify(value.map((item) => JSON.parse(stableStringify(item))));
    }

    if (typeof value === "object" && value !== null) {
        const sortedEntries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, JSON.parse(stableStringify(entryValue))]);
        return JSON.stringify(Object.fromEntries(sortedEntries));
    }

    return JSON.stringify(value);
}

function diffValues(oldValue: unknown, newValue: unknown, path = ""): ManifestDiffChange[] {
    if (shouldIgnorePath(path)) {
        return [];
    }

    if (Object.is(oldValue, newValue)) {
        return [];
    }

    if (oldValue === undefined) {
        return [{ path, kind: "added", severity: severityForPath(path), newValue }];
    }
    if (newValue === undefined) {
        return [{ path, kind: "removed", severity: severityForPath(path), oldValue }];
    }

    const oldIsArray = Array.isArray(oldValue);
    const newIsArray = Array.isArray(newValue);
    if (oldIsArray || newIsArray) {
        if (!oldIsArray || !newIsArray) {
            return [{ path, kind: "type-changed", severity: severityForPath(path), oldValue, newValue }];
        }

        const oldSet = new Set((oldValue as unknown[]).map((value) => stableStringify(value)));
        const newSet = new Set((newValue as unknown[]).map((value) => stableStringify(value)));
        const changes: ManifestDiffChange[] = [];

        for (const value of oldValue as unknown[]) {
            const serialized = stableStringify(value);
            if (!newSet.has(serialized)) {
                changes.push({ path, kind: "removed", severity: severityForPath(path), oldValue: value });
            }
        }
        for (const value of newValue as unknown[]) {
            const serialized = stableStringify(value);
            if (!oldSet.has(serialized)) {
                changes.push({ path, kind: "added", severity: severityForPath(path), newValue: value });
            }
        }

        return changes;
    }

    const oldIsObject = typeof oldValue === "object" && oldValue !== null;
    const newIsObject = typeof newValue === "object" && newValue !== null;
    if (oldIsObject || newIsObject) {
        if (!oldIsObject || !newIsObject) {
            return [{ path, kind: "type-changed", severity: severityForPath(path), oldValue, newValue }];
        }

        const changes: ManifestDiffChange[] = [];
        const keys = new Set([
            ...Object.keys(oldValue as Record<string, unknown>),
            ...Object.keys(newValue as Record<string, unknown>),
        ]);

        for (const key of [...keys].sort()) {
            const nextPath = path ? `${path}.${key}` : key;
            changes.push(
                ...diffValues(
                    (oldValue as Record<string, unknown>)[key],
                    (newValue as Record<string, unknown>)[key],
                    nextPath,
                ),
            );
        }

        return changes;
    }

    if (typeof oldValue !== typeof newValue) {
        return [{ path, kind: "type-changed", severity: severityForPath(path), oldValue, newValue }];
    }

    return [{ path, kind: "changed", severity: severityForPath(path), oldValue, newValue }];
}

export function diffManifests(
    oldManifest: CandidateManifest,
    newManifest: CandidateManifest,
    paths: { oldManifestPath: string; newManifestPath: string },
): ManifestDiffReport {
    const changes = diffValues(oldManifest, newManifest).sort((left, right) => {
        const severityOrder: Record<FieldRisk, number> = {
            critical: 0,
            sensitive: 1,
            "low-risk": 2,
        };
        const severityDelta = severityOrder[left.severity] - severityOrder[right.severity];
        return severityDelta !== 0 ? severityDelta : left.path.localeCompare(right.path);
    });

    return {
        generatedAt: new Date().toISOString(),
        oldManifestPath: paths.oldManifestPath,
        newManifestPath: paths.newManifestPath,
        oldVersion: oldManifest.version,
        newVersion: newManifest.version,
        changes,
        summary: {
            total: changes.length,
            critical: changes.filter((change) => change.severity === "critical").length,
            sensitive: changes.filter((change) => change.severity === "sensitive").length,
            lowRisk: changes.filter((change) => change.severity === "low-risk").length,
        },
    };
}

function formatValue(value: unknown): string {
    if (value === undefined) {
        return "_none_";
    }

    return `\`${JSON.stringify(value)}\``;
}

function formatChange(change: ManifestDiffChange): string {
    if (change.kind === "added") {
        return `- \`${change.path}\` added ${formatValue(change.newValue)}`;
    }
    if (change.kind === "removed") {
        return `- \`${change.path}\` removed ${formatValue(change.oldValue)}`;
    }
    if (change.kind === "type-changed") {
        return `- \`${change.path}\` changed type from ${formatValue(change.oldValue)} to ${formatValue(change.newValue)}`;
    }

    return `- \`${change.path}\` changed from ${formatValue(change.oldValue)} to ${formatValue(change.newValue)}`;
}

export function toMarkdown(report: ManifestDiffReport): string {
    const sections: Array<{ title: string; severity: FieldRisk }> = [
        { title: "Critical changes", severity: "critical" },
        { title: "Sensitive changes", severity: "sensitive" },
        { title: "Low-risk changes", severity: "low-risk" },
    ];

    const lines = [
        `# Candidate Manifest Diff: ${report.oldVersion} -> ${report.newVersion}`,
        "",
        "## Summary",
        "",
        `- Total changes: ${report.summary.total}`,
        `- Critical: ${report.summary.critical}`,
        `- Sensitive: ${report.summary.sensitive}`,
        `- Low-risk: ${report.summary.lowRisk}`,
        `- Generated at: ${report.generatedAt}`,
        "",
    ];

    for (const section of sections) {
        const changes = report.changes.filter((change) => change.severity === section.severity);
        lines.push(`## ${section.title}`);
        lines.push("");
        if (changes.length === 0) {
            lines.push("_None_");
            lines.push("");
            continue;
        }

        for (const change of changes) {
            lines.push(formatChange(change));
        }
        lines.push("");
    }

    return lines.join("\n");
}

function deriveDefaultOutputPath(report: ManifestDiffReport, extension: "json" | "md"): string {
    return resolve(
        process.cwd(),
        "manifests/reports/diffs",
        `${report.oldVersion}-to-${report.newVersion}.${extension}`,
    );
}

function writeTextFile(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
}

async function main(): Promise<void> {
    const parsedArgs = parseArgs(process.argv.slice(2));

    if (parsedArgs.help) {
        printUsage();
        return;
    }

    const oldManifest = validateCandidateManifest(readJsonFile<CandidateManifest>(parsedArgs.oldManifestPath));
    const newManifest = validateCandidateManifest(readJsonFile<CandidateManifest>(parsedArgs.newManifestPath));
    const report = diffManifests(oldManifest, newManifest, {
        oldManifestPath: parsedArgs.oldManifestPath,
        newManifestPath: parsedArgs.newManifestPath,
    });
    const markdown = toMarkdown(report);

    const jsonOutputPath = parsedArgs.jsonOutputPath ?? deriveDefaultOutputPath(report, "json");
    const markdownOutputPath = parsedArgs.markdownOutputPath ?? deriveDefaultOutputPath(report, "md");

    writeTextFile(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
    writeTextFile(markdownOutputPath, `${markdown}\n`);

    console.log(
        JSON.stringify(
            {
                oldVersion: report.oldVersion,
                newVersion: report.newVersion,
                jsonOutputPath,
                markdownOutputPath,
                summary: report.summary,
            },
            null,
            2,
        ),
    );

    if (report.summary.critical > 0) {
        process.exit(2);
    }
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
