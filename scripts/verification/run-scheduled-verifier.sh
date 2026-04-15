#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"

BUN_BIN="${BUN_BIN:-bun}"
NODE_BIN="${NODE_BIN:-node}"
RUN_LABEL="${VERIFIER_RUN_LABEL:-trusted-scheduled-verifier}"
CANDIDATE_INDEX="${VERIFIER_CANDIDATE_INDEX:-${ROOT_DIR}/manifests/candidate/claude-code/index.json}"
CANDIDATE_DIR="${VERIFIER_CANDIDATE_DIR:-${ROOT_DIR}/manifests/candidate/claude-code}"
VERIFIED_DIR="${VERIFIER_VERIFIED_DIR:-${ROOT_DIR}/manifests/verified/claude-code}"
ARTIFACT_ROOT="${VERIFIER_ARTIFACT_ROOT:-${ROOT_DIR}/manifests/reports/verification/scheduled}"
OG_COMMAND_TEMPLATE="${VERIFIER_OG_COMMAND_TEMPLATE:-}"
PLUGIN_COMMAND_TEMPLATE="${VERIFIER_PLUGIN_COMMAND_TEMPLATE:-}"
PROXY_PORT="${VERIFIER_PROXY_PORT:-}"

RUN_MODE="scheduled"
TARGET_VERSION=""
TIMESTAMP=""
ARTIFACT_DIR=""
RUN_LOG=""
REPORT_PATH=""
SUMMARY_PATH=""
PROMOTION_BUNDLE_PATH=""
PR_DESCRIPTION_PATH=""
PROMOTION_RESULT_PATH=""
REVIEW_RESULT_PATH=""
VERIFICATION_RESULT_PATH=""
STATUS="failed"
STATUS_MESSAGE="Not started"
LOCK_DIR="${ARTIFACT_ROOT}/.lock"

declare -a SCENARIO_FLAGS=()

usage() {
	cat <<'EOF'
Usage: bash scripts/verification/run-scheduled-verifier.sh [options]

Runs the trusted verifier in a scheduler-friendly one-shot mode. The script fetches
the newest candidate manifest by default, runs live verification, promotes matching
fields, and writes promotion-ready artifacts to a persistent report directory.

Options:
  --once                  Manual smoke-test mode. Same workflow, clearer summary label.
  --version <ver>         Override the candidate manifest version instead of reading index.json.
  --scenario <id[,id]>    Limit verification to specific scenario IDs. Repeat as needed.
  --help                  Show this help message.

Environment overrides:
  BUN_BIN                         Bun executable (default: bun)
  NODE_BIN                        Node executable for JSON helpers (default: node)
  VERIFIER_RUN_LABEL              Label written into reports and bundles
  VERIFIER_CANDIDATE_INDEX        Candidate manifest index path
  VERIFIER_CANDIDATE_DIR          Candidate manifest directory
  VERIFIER_VERIFIED_DIR           Verified manifest directory
  VERIFIER_ARTIFACT_ROOT          Persistent output root for scheduled artifacts
  VERIFIER_OG_COMMAND_TEMPLATE    Override OG Claude Code command template
  VERIFIER_PLUGIN_COMMAND_TEMPLATE Override plugin/OpenCode command template
  VERIFIER_PROXY_PORT             Fixed proxy port for run-live-verification.ts

Artifacts written per run:
  <artifact-root>/<version>/<timestamp>/run.log
  <artifact-root>/<version>/<timestamp>/verification-report.json
  <artifact-root>/<version>/<timestamp>/promotion-result.json
  <artifact-root>/<version>/<timestamp>/promotion-bundle.json
  <artifact-root>/<version>/<timestamp>/fingerprint_verified.md
  <artifact-root>/<version>/<timestamp>/run-summary.json

Examples:
  bash scripts/verification/run-scheduled-verifier.sh --once
  bash scripts/verification/run-scheduled-verifier.sh --version 2.1.109 --scenario minimal-hi
EOF
}

log_message() {
	local level="$1"
	shift
	local line
	line="[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ${level}: $*"
	if [[ -n "$RUN_LOG" ]]; then
		printf '%s\n' "$line" | tee -a "$RUN_LOG" >&2
		return 0
	fi

	printf '%s\n' "$line" >&2
}

cleanup() {
	if [[ -d "$LOCK_DIR" ]]; then
		rm -rf -- "$LOCK_DIR"
	fi
}

trap cleanup EXIT INT TERM

parse_args() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
		--once)
			RUN_MODE="once"
			shift
			;;
		--version)
			TARGET_VERSION="${2:-}"
			shift 2
			;;
		--scenario)
			SCENARIO_FLAGS+=("--scenario" "${2:-}")
			shift 2
			;;
		--help)
			usage
			exit 0
			;;
		*)
			log_message "ERROR" "Unknown option: $1"
			usage
			exit 1
			;;
		esac
	done
}

require_executable() {
	local command_name="$1"
	if ! command -v "$command_name" >/dev/null 2>&1; then
		log_message "ERROR" "Required executable not found: $command_name"
		exit 1
	fi
}

resolve_latest_candidate_version() {
	"$NODE_BIN" -e '
const fs = require("node:fs");
const indexPath = process.argv[1];
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
if (!index || typeof index.latest !== "string" || index.latest.trim() === "") {
  process.exit(2);
}
process.stdout.write(index.latest.trim());
' "$CANDIDATE_INDEX"
}

write_summary() {
	if [[ -z "$SUMMARY_PATH" ]]; then
		return 0
	fi

	"$NODE_BIN" -e '
const fs = require("node:fs");
const [summaryPath, status, statusMessage, runMode, targetVersion, artifactDir, reportPath, verificationResultPath, promotionResultPath, reviewResultPath, bundlePath, prDescriptionPath] = process.argv.slice(1);
const summary = {
  status,
  statusMessage,
  runMode,
  version: targetVersion || null,
  artifactDir: artifactDir || null,
  reportPath: reportPath || null,
  verificationResultPath: verificationResultPath || null,
  promotionResultPath: promotionResultPath || null,
  reviewResultPath: reviewResultPath || null,
  promotionBundlePath: bundlePath || null,
  prDescriptionPath: prDescriptionPath || null,
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
' "$SUMMARY_PATH" "$STATUS" "$STATUS_MESSAGE" "$RUN_MODE" "$TARGET_VERSION" "$ARTIFACT_DIR" "$REPORT_PATH" "$VERIFICATION_RESULT_PATH" "$PROMOTION_RESULT_PATH" "$REVIEW_RESULT_PATH" "$PROMOTION_BUNDLE_PATH" "$PR_DESCRIPTION_PATH"
}

fail() {
	STATUS="failed"
	STATUS_MESSAGE="$1"
	log_message "ERROR" "$STATUS_MESSAGE"
	write_summary
	exit 1
}

run_command_allow_partial() {
	local stdout_path="$1"
	local stderr_path="$2"
	shift 2

	set +e
	"$@" >"$stdout_path" 2>"$stderr_path"
	local exit_code=$?
	set -e
	return "$exit_code"
}

main() {
	parse_args "$@"
	require_executable "$BUN_BIN"
	require_executable "$NODE_BIN"

	mkdir -p -- "$ARTIFACT_ROOT"
	if ! mkdir "$LOCK_DIR" 2>/dev/null; then
		log_message "WARN" "Another scheduled verifier run is already active. Skipping."
		exit 0
	fi

	if [[ -z "$TARGET_VERSION" ]]; then
		if ! TARGET_VERSION="$(resolve_latest_candidate_version)"; then
			fail "Could not resolve latest candidate manifest version from ${CANDIDATE_INDEX}."
		fi
	fi

	if [[ -z "$TARGET_VERSION" ]]; then
		fail "Target version is empty."
	fi

	TIMESTAMP="$(date -u +'%Y%m%dT%H%M%SZ')"
	ARTIFACT_DIR="${ARTIFACT_ROOT}/${TARGET_VERSION}/${TIMESTAMP}"
	mkdir -p -- "$ARTIFACT_DIR"

	RUN_LOG="${ARTIFACT_DIR}/run.log"
	REPORT_PATH="${ARTIFACT_DIR}/verification-report.json"
	SUMMARY_PATH="${ARTIFACT_DIR}/run-summary.json"
	PROMOTION_BUNDLE_PATH="${ARTIFACT_DIR}/promotion-bundle.json"
	PR_DESCRIPTION_PATH="${ARTIFACT_DIR}/fingerprint_verified.md"
	VERIFICATION_RESULT_PATH="${ARTIFACT_DIR}/verification-result.json"
	PROMOTION_RESULT_PATH="${ARTIFACT_DIR}/promotion-result.json"
	REVIEW_RESULT_PATH="${ARTIFACT_DIR}/review-result.json"

	local verification_stderr="${ARTIFACT_DIR}/verification.stderr.log"
	local promotion_stderr="${ARTIFACT_DIR}/promotion.stderr.log"
	local review_stderr="${ARTIFACT_DIR}/review.stderr.log"

	log_message "INFO" "Starting ${RUN_MODE} verification for version ${TARGET_VERSION}"
	log_message "INFO" "Artifacts: ${ARTIFACT_DIR}"

	local -a verification_args=(
		"$BUN_BIN"
		"${ROOT_DIR}/scripts/verification/run-live-verification.ts"
		"--version"
		"$TARGET_VERSION"
		"--report"
		"$REPORT_PATH"
		"--verified-by"
		"$RUN_LABEL"
	)
	verification_args+=("${SCENARIO_FLAGS[@]}")
	if [[ -n "$OG_COMMAND_TEMPLATE" ]]; then
		verification_args+=("--og-command-template" "$OG_COMMAND_TEMPLATE")
	fi
	if [[ -n "$PLUGIN_COMMAND_TEMPLATE" ]]; then
		verification_args+=("--plugin-command-template" "$PLUGIN_COMMAND_TEMPLATE")
	fi
	if [[ -n "$PROXY_PORT" ]]; then
		verification_args+=("--proxy-port" "$PROXY_PORT")
	fi

	local verification_exit=0
	if ! run_command_allow_partial "$VERIFICATION_RESULT_PATH" "$verification_stderr" "${verification_args[@]}"; then
		verification_exit=$?
	fi

	if [[ "$verification_exit" -ne 0 && "$verification_exit" -ne 2 ]]; then
		fail "Live verification failed with exit code ${verification_exit}. See ${verification_stderr}."
	fi

	if [[ "$verification_exit" -eq 2 ]]; then
		STATUS="partial"
		STATUS_MESSAGE="Verification completed with mismatches; promoted matching fields only."
		log_message "WARN" "$STATUS_MESSAGE"
	else
		STATUS="success"
		STATUS_MESSAGE="Verification completed with no mismatches."
	fi

	local -a promotion_args=(
		"$BUN_BIN"
		"${ROOT_DIR}/scripts/verification/promote-verified.ts"
		"--version"
		"$TARGET_VERSION"
		"--report"
		"$REPORT_PATH"
		"--verified-by"
		"$RUN_LABEL"
		"--verified-dir"
		"$VERIFIED_DIR"
	)

	if ! run_command_allow_partial "$PROMOTION_RESULT_PATH" "$promotion_stderr" "${promotion_args[@]}"; then
		fail "Verified manifest promotion failed. See ${promotion_stderr}."
	fi

	local -a review_args=(
		"$BUN_BIN"
		"${ROOT_DIR}/scripts/verification/promotion-cli.ts"
		"--report"
		"$REPORT_PATH"
		"--candidate-dir"
		"$CANDIDATE_DIR"
		"--verified-dir"
		"$VERIFIED_DIR"
		"--approve-mode"
		"promotable"
		"--reviewed-by"
		"$RUN_LABEL"
		"--export-bundle"
		"$PROMOTION_BUNDLE_PATH"
		"--pr-description"
		"$PR_DESCRIPTION_PATH"
	)

	if ! run_command_allow_partial "$REVIEW_RESULT_PATH" "$review_stderr" "${review_args[@]}"; then
		fail "Promotion bundle export failed. See ${review_stderr}."
	fi

	write_summary
	log_message "INFO" "Scheduled verifier finished: ${STATUS}"
	log_message "INFO" "Summary: ${SUMMARY_PATH}"
}

main "$@"
