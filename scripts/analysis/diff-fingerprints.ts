#!/usr/bin/env bun
/**
 * diff-fingerprints.ts — Compare two version fingerprints
 * Usage: bun scripts/analysis/diff-fingerprints.ts <old.json> <new.json> [--json]
 */

import { readFileSync } from "node:fs";
import type { DiffChange, DiffSeverity, Fingerprint, FingerprintDiff } from "./types.ts";

// ANSI color helpers
const colors = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function severityOf(path: string): DiffSeverity {
  if (path.includes("clientId") || path.includes("oauthBeta") || path.includes("tokenEndpoint")) return "HIGH";
  if (path.includes("scopes") || path.includes("pkce") || path.includes("template")) return "HIGH";
  if (path.includes("sdkVersion") || path.includes("axiosVersion") || path.includes("betas")) return "MEDIUM";
  return "LOW";
}

function deepDiff(oldVal: unknown, newVal: unknown, path = ""): Omit<DiffChange, "severity">[] {
  const changes: Omit<DiffChange, "severity">[] = [];

  if (typeof oldVal !== typeof newVal) {
    changes.push({ path, type: "type_changed", old: oldVal, new: newVal });
    return changes;
  }

  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const serialize = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : v);
    const oldSet = oldVal.map(serialize);
    const newSet = newVal.map(serialize);
    const added = newVal.filter((v) => !oldSet.includes(serialize(v)));
    const removed = oldVal.filter((v) => !newSet.includes(serialize(v)));
    if (added.length) changes.push({ path, type: "added", values: added });
    if (removed.length) changes.push({ path, type: "removed", values: removed });
    return changes;
  }

  if (typeof oldVal === "object" && oldVal !== null && newVal !== null) {
    const allKeys = new Set([
      ...Object.keys(oldVal as Record<string, unknown>),
      ...Object.keys(newVal as Record<string, unknown>),
    ]);
    for (const key of allKeys) {
      const o = oldVal as Record<string, unknown>;
      const n = newVal as Record<string, unknown>;
      if (!(key in o)) {
        changes.push({ path: `${path}.${key}`, type: "added", new: n[key] });
      } else if (!(key in n)) {
        changes.push({ path: `${path}.${key}`, type: "removed", old: o[key] });
      } else {
        changes.push(...deepDiff(o[key], n[key], `${path}.${key}`));
      }
    }
    return changes;
  }

  if (oldVal !== newVal) {
    changes.push({ path, type: "changed", old: oldVal, new: newVal });
  }
  return changes;
}

export function diffFingerprints(oldFp: Fingerprint, newFp: Fingerprint): FingerprintDiff {
  const rawChanges = deepDiff(oldFp, newFp);
  const changes: DiffChange[] = rawChanges.map((c) => ({
    ...c,
    severity: severityOf(c.path),
  }));

  const summary = {
    total: changes.length,
    high: changes.filter((c) => c.severity === "HIGH").length,
    medium: changes.filter((c) => c.severity === "MEDIUM").length,
    low: changes.filter((c) => c.severity === "LOW").length,
  };

  return {
    oldVersion: oldFp.version,
    newVersion: newFp.version,
    changes,
    summary,
  };
}

function colorForSeverity(severity: DiffSeverity): (s: string) => string {
  if (severity === "HIGH") return colors.red;
  if (severity === "MEDIUM") return colors.yellow;
  return colors.dim;
}

function formatChange(change: DiffChange): string {
  const colorFn = colorForSeverity(change.severity);
  const tag = colorFn(`[${change.severity}]`);
  const path = colors.bold(change.path);

  switch (change.type) {
    case "type_changed":
      return `${tag} ${path} type changed: ${JSON.stringify(change.old)} → ${JSON.stringify(change.new)}`;
    case "added":
      if (change.values) {
        return `${tag} ${path} added: ${JSON.stringify(change.values)}`;
      }
      return `${tag} ${path} added: ${JSON.stringify(change.new)}`;
    case "removed":
      if (change.values) {
        return `${tag} ${path} removed: ${JSON.stringify(change.values)}`;
      }
      return `${tag} ${path} removed: ${JSON.stringify(change.old)}`;
    case "changed":
      return `${tag} ${path} changed: ${JSON.stringify(change.old)} → ${JSON.stringify(change.new)}`;
    default:
      return `${tag} ${path} ${change.type}`;
  }
}

function printDiff(diff: FingerprintDiff): void {
  console.log(colors.bold(`\nFingerprint diff: ${diff.oldVersion} → ${diff.newVersion}\n`));

  if (diff.changes.length === 0) {
    console.log(colors.green("  No differences found."));
    return;
  }

  // Sort by severity: HIGH first, then MEDIUM, then LOW
  const order: Record<DiffSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sorted = [...diff.changes].sort((a, b) => order[a.severity] - order[b.severity]);

  for (const change of sorted) {
    console.log(`  ${formatChange(change)}`);
  }

  console.log(
    `\n  Summary: ${colors.bold(String(diff.summary.total))} changes — ` +
      `${colors.red(String(diff.summary.high))} high, ` +
      `${colors.yellow(String(diff.summary.medium))} medium, ` +
      `${colors.dim(String(diff.summary.low))} low\n`,
  );
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes("--json");
  const files = args.filter((a) => !a.startsWith("--"));

  if (files.length < 2) {
    console.error("Usage: bun scripts/analysis/diff-fingerprints.ts <old.json> <new.json> [--json]");
    process.exit(1);
  }

  const oldFp: Fingerprint = JSON.parse(readFileSync(files[0], "utf-8"));
  const newFp: Fingerprint = JSON.parse(readFileSync(files[1], "utf-8"));

  const diff = diffFingerprints(oldFp, newFp);

  if (jsonFlag) {
    console.log(JSON.stringify(diff, null, 2));
  } else {
    printDiff(diff);
  }

  // Exit with non-zero if HIGH severity changes found
  if (diff.summary.high > 0) {
    process.exit(2);
  }
}
