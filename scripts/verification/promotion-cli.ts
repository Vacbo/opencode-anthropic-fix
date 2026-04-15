#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { confirm, isCancel, log, note, select } from "@clack/prompts";

import { validateCandidateManifest, validateVerifiedManifest } from "../../src/fingerprint/schema.ts";
import type {
    CandidateManifest,
    FieldRisk,
    RejectedField,
    VerificationReport,
    VerifiedManifest,
} from "../../src/fingerprint/types.ts";
import { buildFieldDecision, flattenCandidateFields } from "./promote-verified.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const DEFAULT_REPORT_DIR = resolve(REPO_ROOT, "manifests/reports/verification");
const DEFAULT_CANDIDATE_DIR = resolve(REPO_ROOT, "manifests/candidate/claude-code");
const DEFAULT_VERIFIED_DIR = resolve(REPO_ROOT, "manifests/verified/claude-code");
const DEFAULT_REVIEWED_BY = "manual-promotion-review";

type ApproveMode = "interactive" | "promotable" | "none";

interface ParsedArgs {
    reportPath?: string;
    version?: string;
    reportDir: string;
    candidateDir: string;
    verifiedDir: string;
    approveMode: ApproveMode;
    approveFields: Set<string>;
    rejectFields: Set<string>;
    apply: boolean;
    list: boolean;
    exportBundlePath?: string;
    prDescriptionPath?: string;
    reviewedBy: string;
    help: boolean;
}

export interface PendingVerification {
    version: string;
    reportPath: string;
    relativeReportPath: string;
    candidatePath: string;
    verifiedAt: string;
    scenarioCount: number;
    mismatchedFieldCount: number;
}

export interface ReviewedPromotionField {
    path: string;
    value: unknown;
    risk: FieldRisk;
    scenarioIds: string[];
    evidenceRef?: string;
}

export interface HeldBackPromotionField extends ReviewedPromotionField {
    reason: string;
}

export interface AutoRejectedPromotionField extends RejectedField {
    risk: FieldRisk;
}

export interface PromotionReviewBundle {
    schemaVersion: "1.0.0";
    generatedAt: string;
    version: string;
    reviewedBy: string;
    reportPath: string;
    relativeReportPath: string;
    candidatePath: string;
    scenarioIds: string[];
    reportSummary: VerificationReport["summary"];
    approvedPromotions: ReviewedPromotionField[];
    withheldPromotions: HeldBackPromotionField[];
    autoRejectedFields: AutoRejectedPromotionField[];
    riskSummary: Record<FieldRisk, { approved: number; withheld: number; autoRejected: number }>;
}

interface ReviewSelection {
    approvedPaths: Set<string>;
    rejectPaths: Set<string>;
}

function printUsage(): void {
    console.log(`Usage: bun scripts/verification/promotion-cli.ts [options]

Interactive review workflow for live verification reports. The CLI can list pending
reports, review promotable fields, optionally apply the approved subset, generate a
verified-manifest PR description, and export a promotion bundle for follow-up work.

Options:
  --list                         List pending verification reports as JSON
  --report <path>                Explicit verification report path to review
  --version <ver>                Pick the newest pending report for a version
  --report-dir <path>            Verification report directory
                                 Default: manifests/reports/verification
  --candidate-dir <path>         Candidate manifest directory
                                 Default: manifests/candidate/claude-code
  --verified-dir <path>          Verified manifest directory
                                 Default: manifests/verified/claude-code
  --approve-mode <mode>          interactive | promotable | none
                                 Default: interactive when TTY, otherwise promotable
  --approve-field <path[,path]>  Explicitly approve field path(s)
  --reject-field <path[,path]>   Explicitly hold back field path(s)
  --apply                        Apply the approved subset to the verified manifest
  --export-bundle <path>         Write a JSON promotion bundle
  --pr-description <path>        Write a PR description markdown file
  --reviewed-by <label>          Reviewer label stored in exported artifacts
                                 Default: ${DEFAULT_REVIEWED_BY}
  --help                         Show this help message

Examples:
  bun scripts/verification/promotion-cli.ts
  bun scripts/verification/promotion-cli.ts --list
  bun scripts/verification/promotion-cli.ts --version 2.1.109 --approve-mode promotable \
      --export-bundle ./tmp/2.1.109.bundle.json --pr-description ./tmp/2.1.109.pr.md
  bun scripts/verification/promotion-cli.ts --report manifests/reports/verification/2.1.109.json \
      --approve-field headers.userAgent --reject-field headers.xApp --apply
`);
}

function splitFieldPaths(value: string): string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

export function parseArgs(args: string[]): ParsedArgs {
    let reportPath: string | undefined;
    let version: string | undefined;
    let reportDir = DEFAULT_REPORT_DIR;
    let candidateDir = DEFAULT_CANDIDATE_DIR;
    let verifiedDir = DEFAULT_VERIFIED_DIR;
    let approveMode: ApproveMode = process.stdin.isTTY ? "interactive" : "promotable";
    const approveFields = new Set<string>();
    const rejectFields = new Set<string>();
    let apply = false;
    let list = false;
    let exportBundlePath: string | undefined;
    let prDescriptionPath: string | undefined;
    let reviewedBy = DEFAULT_REVIEWED_BY;
    let help = false;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--help") {
            help = true;
            continue;
        }
        if (arg === "--list") {
            list = true;
            continue;
        }
        if (arg === "--apply") {
            apply = true;
            continue;
        }
        if (arg === "--report" && index + 1 < args.length) {
            reportPath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--version" && index + 1 < args.length) {
            version = (args[index + 1] ?? "").trim() || undefined;
            index += 1;
            continue;
        }
        if (arg === "--report-dir" && index + 1 < args.length) {
            reportDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--candidate-dir" && index + 1 < args.length) {
            candidateDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--verified-dir" && index + 1 < args.length) {
            verifiedDir = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--approve-mode" && index + 1 < args.length) {
            const nextMode = (args[index + 1] ?? "").trim() as ApproveMode;
            if (!["interactive", "promotable", "none"].includes(nextMode)) {
                throw new Error(`Invalid --approve-mode '${nextMode}'. Use interactive, promotable, or none.`);
            }
            approveMode = nextMode;
            index += 1;
            continue;
        }
        if (arg === "--approve-field" && index + 1 < args.length) {
            for (const fieldPath of splitFieldPaths(args[index + 1] ?? "")) {
                approveFields.add(fieldPath);
            }
            index += 1;
            continue;
        }
        if (arg === "--reject-field" && index + 1 < args.length) {
            for (const fieldPath of splitFieldPaths(args[index + 1] ?? "")) {
                rejectFields.add(fieldPath);
            }
            index += 1;
            continue;
        }
        if (arg === "--export-bundle" && index + 1 < args.length) {
            exportBundlePath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--pr-description" && index + 1 < args.length) {
            prDescriptionPath = resolve(args[index + 1] ?? "");
            index += 1;
            continue;
        }
        if (arg === "--reviewed-by" && index + 1 < args.length) {
            reviewedBy = (args[index + 1] ?? "").trim() || DEFAULT_REVIEWED_BY;
            index += 1;
        }
    }

    if (approveMode === "interactive" && !process.stdin.isTTY && !help) {
        throw new Error(
            "--approve-mode interactive requires a TTY. Use --approve-mode promotable or --approve-mode none.",
        );
    }

    return {
        reportPath,
        version,
        reportDir,
        candidateDir,
        verifiedDir,
        approveMode,
        approveFields,
        rejectFields,
        apply,
        list,
        exportBundlePath,
        prDescriptionPath,
        reviewedBy,
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

function writeTextFile(filePath: string, value: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, value, "utf8");
}

function isVerificationReport(value: unknown): value is VerificationReport {
    if (!value || typeof value !== "object") {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.version === "string" &&
        typeof candidate.verifiedAt === "string" &&
        Array.isArray(candidate.scenarioResults) &&
        typeof candidate.summary === "object" &&
        candidate.summary !== null
    );
}

function walkJsonFiles(directory: string): string[] {
    if (!existsSync(directory)) {
        return [];
    }

    const filePaths: string[] = [];
    for (const entry of readdirSync(directory)) {
        const fullPath = join(directory, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
            filePaths.push(...walkJsonFiles(fullPath));
            continue;
        }
        if (stats.isFile() && entry.endsWith(".json")) {
            filePaths.push(fullPath);
        }
    }
    return filePaths.sort();
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split(".").map((entry) => Number.parseInt(entry, 10));
    const rightParts = right.split(".").map((entry) => Number.parseInt(entry, 10));
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

function comparePendingReports(left: PendingVerification, right: PendingVerification): number {
    const versionDifference = compareVersions(right.version, left.version);
    if (versionDifference !== 0) {
        return versionDifference;
    }
    return right.verifiedAt.localeCompare(left.verifiedAt);
}

function comparableReportRefs(reportPath: string, repoRoot: string): Set<string> {
    const normalizedPath = resolve(reportPath);
    const refs = new Set<string>([normalizedPath]);
    const relativePath = relative(repoRoot, normalizedPath);
    if (!relativePath.startsWith("..")) {
        refs.add(relativePath);
    }
    return refs;
}

function readAppliedEvidenceRefs(verifiedDir: string, repoRoot: string): Set<string> {
    const refs = new Set<string>();
    for (const filePath of walkJsonFiles(verifiedDir)) {
        if (filePath.endsWith("index.json")) {
            continue;
        }
        try {
            const manifest = validateVerifiedManifest(readJsonFile<VerifiedManifest>(filePath));
            for (const evidenceRef of manifest.evidenceArtifacts) {
                refs.add(evidenceRef);
                if (!evidenceRef.startsWith("/")) {
                    refs.add(resolve(repoRoot, evidenceRef));
                }
            }
        } catch {
            continue;
        }
    }
    return refs;
}

export function discoverPendingVerifications(input: {
    reportDir: string;
    candidateDir: string;
    verifiedDir: string;
    repoRoot?: string;
}): PendingVerification[] {
    const repoRoot = input.repoRoot ?? REPO_ROOT;
    const appliedRefs = readAppliedEvidenceRefs(input.verifiedDir, repoRoot);
    const pending: PendingVerification[] = [];

    for (const reportPath of walkJsonFiles(input.reportDir)) {
        const report = (() => {
            try {
                const value = readJsonFile<unknown>(reportPath);
                return isVerificationReport(value) ? value : null;
            } catch {
                return null;
            }
        })();
        if (!report) {
            continue;
        }

        const reportRefs = comparableReportRefs(reportPath, repoRoot);
        if ([...reportRefs].some((ref) => appliedRefs.has(ref))) {
            continue;
        }

        const candidatePath = join(input.candidateDir, `${report.version}.json`);
        if (!existsSync(candidatePath)) {
            continue;
        }

        pending.push({
            version: report.version,
            reportPath,
            relativeReportPath: relative(repoRoot, reportPath),
            candidatePath,
            verifiedAt: report.verifiedAt,
            scenarioCount: report.summary.totalScenarios,
            mismatchedFieldCount: report.summary.mismatchedFields,
        });
    }

    return pending.sort(comparePendingReports);
}

function relativeEvidencePath(filePath: string): string {
    const normalizedPath = resolve(filePath);
    const relativePath = relative(REPO_ROOT, normalizedPath);
    return relativePath.startsWith("..") ? normalizedPath : relativePath;
}

function riskForPath(candidate: CandidateManifest, path: string): FieldRisk {
    return flattenCandidateFields(candidate).get(path)?.risk ?? "sensitive";
}

function buildRiskSummary(): PromotionReviewBundle["riskSummary"] {
    return {
        critical: { approved: 0, withheld: 0, autoRejected: 0 },
        sensitive: { approved: 0, withheld: 0, autoRejected: 0 },
        "low-risk": { approved: 0, withheld: 0, autoRejected: 0 },
    };
}

export function buildPromotionReviewBundle(input: {
    candidate: CandidateManifest;
    report: VerificationReport;
    reportPath: string;
    candidatePath?: string;
    reviewedBy: string;
    approvedPaths?: ReadonlySet<string>;
}): PromotionReviewBundle {
    const evidenceRef = relativeEvidencePath(input.reportPath);
    const decision = buildFieldDecision(input.candidate, input.report, input.reviewedBy, evidenceRef);
    const promotablePaths = decision.promoted.map((field) => field.path);
    const approvedPaths = input.approvedPaths ?? new Set(promotablePaths);
    const riskSummary = buildRiskSummary();

    const approvedPromotions: ReviewedPromotionField[] = [];
    const withheldPromotions: HeldBackPromotionField[] = [];
    for (const field of decision.promoted) {
        const promotion: ReviewedPromotionField = {
            path: field.path,
            value: field.value,
            risk: riskForPath(input.candidate, field.path),
            scenarioIds: field.scenarioIds,
            evidenceRef: field.evidenceRef,
        };

        if (approvedPaths.has(field.path)) {
            approvedPromotions.push(promotion);
            riskSummary[promotion.risk].approved += 1;
            continue;
        }

        withheldPromotions.push({
            ...promotion,
            reason: "Held back during manual review",
        });
        riskSummary[promotion.risk].withheld += 1;
    }

    const autoRejectedFields = decision.rejected.map((field) => {
        const risk = riskForPath(input.candidate, field.path);
        riskSummary[risk].autoRejected += 1;
        return {
            ...field,
            risk,
        };
    });

    return {
        schemaVersion: "1.0.0",
        generatedAt: new Date().toISOString(),
        version: input.report.version,
        reviewedBy: input.reviewedBy,
        reportPath: resolve(input.reportPath),
        relativeReportPath: evidenceRef,
        candidatePath: relativeEvidencePath(
            input.candidatePath ?? join(DEFAULT_CANDIDATE_DIR, `${input.report.version}.json`),
        ),
        scenarioIds: [...new Set(input.report.scenarioResults.map((scenario) => scenario.scenarioId))].sort(),
        reportSummary: input.report.summary,
        approvedPromotions: approvedPromotions.sort((left, right) => left.path.localeCompare(right.path)),
        withheldPromotions: withheldPromotions.sort((left, right) => left.path.localeCompare(right.path)),
        autoRejectedFields: autoRejectedFields.sort((left, right) => left.path.localeCompare(right.path)),
        riskSummary,
    };
}

function renderFieldList(
    fields: Array<{ path: string; risk: FieldRisk; reason?: string }>,
    emptyState: string,
): string {
    if (fields.length === 0) {
        return emptyState;
    }
    return fields
        .map((field) => `- \`${field.path}\` (${field.risk})${field.reason ? ` — ${field.reason}` : ""}`)
        .join("\n");
}

export function renderVerifiedPrDescription(bundle: PromotionReviewBundle): string {
    return `## Summary
- Promote ${bundle.approvedPromotions.length} verified field(s) for Claude Code ${bundle.version}.
- Hold back ${bundle.withheldPromotions.length} field(s) pending follow-up review.
- Keep ${bundle.autoRejectedFields.length} field(s) out of the verified overlay because live verification disagreed.

## Changes
### Approved promotions
${renderFieldList(bundle.approvedPromotions, "- None")}

### Held back during review
${renderFieldList(bundle.withheldPromotions, "- None")}

### Auto-rejected by live verification
${renderFieldList(bundle.autoRejectedFields, "- None")}

## Verification Evidence
- Report: \`${bundle.relativeReportPath}\`
- Reviewed by: \`${bundle.reviewedBy}\`
- Scenario IDs: ${bundle.scenarioIds.length > 0 ? bundle.scenarioIds.map((scenario) => `\`${scenario}\``).join(", ") : "None"}
- Summary: ${bundle.reportSummary.matchingFields}/${bundle.reportSummary.totalFields} field comparisons matched across ${bundle.reportSummary.totalScenarios} scenario(s)

## Risk Assessment
- Critical — approved: ${bundle.riskSummary.critical.approved}, held back: ${bundle.riskSummary.critical.withheld}, auto-rejected: ${bundle.riskSummary.critical.autoRejected}
- Sensitive — approved: ${bundle.riskSummary.sensitive.approved}, held back: ${bundle.riskSummary.sensitive.withheld}, auto-rejected: ${bundle.riskSummary.sensitive.autoRejected}
- Low-risk — approved: ${bundle.riskSummary["low-risk"].approved}, held back: ${bundle.riskSummary["low-risk"].withheld}, auto-rejected: ${bundle.riskSummary["low-risk"].autoRejected}

## Reviewer Checklist
- [ ] The attached verification report is sanitized and matches the referenced artifact path.
- [ ] Approved fields are limited to values confirmed by live verification.
- [ ] Any held-back or auto-rejected fields have a follow-up owner before merge.
- [ ] The verified manifest diff matches the paths listed above.
`;
}

function previewValue(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (!serialized) {
        return String(value);
    }
    return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

function promptSelectionResult<T>(value: T | symbol): T {
    if (isCancel(value)) {
        throw new Error("Interactive review cancelled.");
    }
    return value as T;
}

async function reviewPromotionsInteractively(
    candidate: CandidateManifest,
    report: VerificationReport,
    reviewedBy: string,
): Promise<ReviewSelection> {
    const evidenceRef = relativeEvidencePath(join(DEFAULT_REPORT_DIR, `${report.version}.json`));
    const decision = buildFieldDecision(candidate, report, reviewedBy, evidenceRef);
    const approvedPaths = new Set<string>();
    const rejectPaths = new Set<string>();

    if (decision.promoted.length === 0) {
        note("No promotable fields were found in this report.", `Report ${report.version}`);
        return { approvedPaths, rejectPaths };
    }

    const mode = promptSelectionResult(
        await select({
            message: `Review ${decision.promoted.length} promotable field(s) for ${report.version}`,
            options: [
                { value: "approve-all", label: "Approve all promotable fields" },
                { value: "reject-all", label: "Reject all promotable fields" },
                { value: "review-one-by-one", label: "Review fields individually" },
            ],
        }),
    );

    if (mode === "approve-all") {
        for (const field of decision.promoted) {
            approvedPaths.add(field.path);
        }
        return { approvedPaths, rejectPaths };
    }

    if (mode === "reject-all") {
        for (const field of decision.promoted) {
            rejectPaths.add(field.path);
        }
        return { approvedPaths, rejectPaths };
    }

    for (let index = 0; index < decision.promoted.length; index += 1) {
        const field = decision.promoted[index];
        const risk = riskForPath(candidate, field.path);
        note(
            [`Risk: ${risk}`, `Scenarios: ${field.scenarioIds.join(", ")}`, `Value: ${previewValue(field.value)}`].join(
                "\n",
            ),
            field.path,
        );

        const fieldDecision = promptSelectionResult(
            await select({
                message: `Field ${index + 1} of ${decision.promoted.length}`,
                options: [
                    { value: "approve", label: "Approve this field" },
                    { value: "reject", label: "Hold back this field" },
                    { value: "approve-rest", label: "Approve this and the remaining fields" },
                    { value: "reject-rest", label: "Reject this and the remaining fields" },
                ],
            }),
        );

        if (fieldDecision === "approve") {
            approvedPaths.add(field.path);
            continue;
        }

        if (fieldDecision === "reject") {
            rejectPaths.add(field.path);
            continue;
        }

        if (fieldDecision === "approve-rest") {
            for (const remainingField of decision.promoted.slice(index)) {
                approvedPaths.add(remainingField.path);
            }
            break;
        }

        for (const remainingField of decision.promoted.slice(index)) {
            rejectPaths.add(remainingField.path);
        }
        break;
    }

    return { approvedPaths, rejectPaths };
}

function buildReviewSelection(bundleCandidatePaths: string[], args: ParsedArgs): ReviewSelection {
    const approvedPaths = new Set<string>();
    const rejectPaths = new Set<string>(args.rejectFields);

    if (args.approveMode === "promotable") {
        for (const path of bundleCandidatePaths) {
            approvedPaths.add(path);
        }
    }

    if (args.approveFields.size > 0) {
        approvedPaths.clear();
        for (const path of args.approveFields) {
            approvedPaths.add(path);
        }
    }

    for (const path of rejectPaths) {
        approvedPaths.delete(path);
    }

    return { approvedPaths, rejectPaths };
}

function resolveReportFromArgsOrPending(args: ParsedArgs, pending: PendingVerification[]): PendingVerification | null {
    if (args.reportPath) {
        const selected = pending.find((entry) => entry.reportPath === args.reportPath);
        if (selected) {
            return selected;
        }

        const report = readJsonFile<unknown>(args.reportPath);
        if (!isVerificationReport(report)) {
            throw new Error(`Report ${args.reportPath} is not a verification report.`);
        }

        return {
            version: report.version,
            reportPath: args.reportPath,
            relativeReportPath: relative(REPO_ROOT, args.reportPath),
            candidatePath: join(args.candidateDir, `${report.version}.json`),
            verifiedAt: report.verifiedAt,
            scenarioCount: report.summary.totalScenarios,
            mismatchedFieldCount: report.summary.mismatchedFields,
        };
    }

    if (args.version) {
        return pending.find((entry) => entry.version === args.version) ?? null;
    }

    return pending[0] ?? null;
}

async function choosePendingReportInteractively(pending: PendingVerification[]): Promise<PendingVerification> {
    if (pending.length === 0) {
        throw new Error("No pending verification reports found.");
    }

    const selection = promptSelectionResult(
        await select({
            message: "Select a verification report to review",
            options: pending.map((entry) => ({
                value: entry.reportPath,
                label: `${entry.version} — ${entry.relativeReportPath}`,
                hint: `${entry.scenarioCount} scenario(s), ${entry.mismatchedFieldCount} mismatched field(s)`,
            })),
        }),
    );

    const chosen = pending.find((entry) => entry.reportPath === selection);
    if (!chosen) {
        throw new Error("Selected report is no longer available.");
    }
    return chosen;
}

function defaultBundlePath(reportPath: string): string {
    return reportPath.replace(/\.json$/u, ".promotion-bundle.json");
}

function defaultPrDescriptionPath(reportPath: string): string {
    return reportPath.replace(/\.json$/u, ".fingerprint-verified.md");
}

function applyReviewedPromotion(input: {
    version: string;
    reportPath: string;
    candidatePath: string;
    verifiedDir: string;
    reviewedBy: string;
    approvedPaths: string[];
}): Record<string, unknown> {
    if (input.approvedPaths.length === 0) {
        return {
            applied: false,
            reason: "No approved fields selected",
        };
    }

    const promoteScriptPath = resolve(SCRIPT_DIR, "promote-verified.ts");
    const commandArgs = [
        promoteScriptPath,
        "--version",
        input.version,
        "--report",
        input.reportPath,
        "--candidate",
        input.candidatePath,
        "--verified-dir",
        input.verifiedDir,
        "--verified-by",
        input.reviewedBy,
        ...input.approvedPaths.flatMap((path) => ["--only-field", path]),
    ];
    const stdout = execFileSync("bun", commandArgs, {
        cwd: REPO_ROOT,
        encoding: "utf8",
    });

    return JSON.parse(stdout) as Record<string, unknown>;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printUsage();
        return;
    }

    const pending = discoverPendingVerifications({
        reportDir: args.reportDir,
        candidateDir: args.candidateDir,
        verifiedDir: args.verifiedDir,
    });

    if (args.list) {
        console.log(JSON.stringify({ pending }, null, 2));
        return;
    }

    let selected = resolveReportFromArgsOrPending(args, pending);
    if (!selected && process.stdin.isTTY) {
        selected = await choosePendingReportInteractively(pending);
    }
    if (!selected) {
        throw new Error("No verification report selected. Use --report, --version, or --list.");
    }

    const candidate = validateCandidateManifest(readJsonFile<CandidateManifest>(selected.candidatePath));
    const reportValue = readJsonFile<unknown>(selected.reportPath);
    if (!isVerificationReport(reportValue)) {
        throw new Error(`Report ${selected.reportPath} is not a verification report.`);
    }
    const report = reportValue;

    let selection = buildReviewSelection(
        buildFieldDecision(candidate, report, args.reviewedBy, relativeEvidencePath(selected.reportPath)).promoted.map(
            (field) => field.path,
        ),
        args,
    );
    if (args.approveMode === "interactive" && args.approveFields.size === 0 && args.rejectFields.size === 0) {
        selection = await reviewPromotionsInteractively(candidate, report, args.reviewedBy);
    }

    const bundle = buildPromotionReviewBundle({
        candidate,
        report,
        reportPath: selected.reportPath,
        candidatePath: selected.candidatePath,
        reviewedBy: args.reviewedBy,
        approvedPaths: selection.approvedPaths,
    });

    if (process.stdin.isTTY) {
        note(
            [
                `Approved: ${bundle.approvedPromotions.length}`,
                `Held back: ${bundle.withheldPromotions.length}`,
                `Auto-rejected: ${bundle.autoRejectedFields.length}`,
                `Report: ${bundle.relativeReportPath}`,
            ].join("\n"),
            `Promotion review for ${bundle.version}`,
        );
    }

    const exportBundlePath =
        args.exportBundlePath ?? (process.stdin.isTTY ? defaultBundlePath(selected.reportPath) : undefined);
    const prDescriptionPath =
        args.prDescriptionPath ?? (process.stdin.isTTY ? defaultPrDescriptionPath(selected.reportPath) : undefined);

    if (exportBundlePath) {
        writeTextFile(exportBundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    }

    if (prDescriptionPath) {
        writeTextFile(prDescriptionPath, `${renderVerifiedPrDescription(bundle)}\n`);
    }

    let applyResult: Record<string, unknown> | null = null;
    if (args.apply) {
        applyResult = applyReviewedPromotion({
            version: bundle.version,
            reportPath: selected.reportPath,
            candidatePath: selected.candidatePath,
            verifiedDir: args.verifiedDir,
            reviewedBy: args.reviewedBy,
            approvedPaths: bundle.approvedPromotions.map((field) => field.path),
        });
    } else if (process.stdin.isTTY && bundle.approvedPromotions.length > 0) {
        const shouldApply = promptSelectionResult(
            await confirm({
                message: `Apply ${bundle.approvedPromotions.length} approved field(s) to the verified manifest now?`,
                initialValue: false,
            }),
        );
        if (shouldApply) {
            applyResult = applyReviewedPromotion({
                version: bundle.version,
                reportPath: selected.reportPath,
                candidatePath: selected.candidatePath,
                verifiedDir: args.verifiedDir,
                reviewedBy: args.reviewedBy,
                approvedPaths: bundle.approvedPromotions.map((field) => field.path),
            });
        }
    }

    if (process.stdin.isTTY) {
        log.success(
            `Reviewed ${bundle.version}: ${bundle.approvedPromotions.length} approved, ${bundle.withheldPromotions.length} held back.`,
        );
    }

    console.log(
        JSON.stringify(
            {
                version: bundle.version,
                reportPath: selected.reportPath,
                bundlePath: exportBundlePath ?? null,
                prDescriptionPath: prDescriptionPath ?? null,
                approvedFields: bundle.approvedPromotions.map((field) => field.path),
                withheldFields: bundle.withheldPromotions.map((field) => field.path),
                autoRejectedFields: bundle.autoRejectedFields.map((field) => ({
                    path: field.path,
                    risk: field.risk,
                    reason: field.rejectionReason,
                })),
                applyResult,
            },
            null,
            2,
        ),
    );
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
