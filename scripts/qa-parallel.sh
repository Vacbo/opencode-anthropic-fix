#!/usr/bin/env bash

set -euo pipefail

REQUEST_COUNT=50
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opencode-qa.XXXXXX")
RESPONSES_DIR="$TMP_DIR/responses"
ERRORS_DIR="$TMP_DIR/errors"
STATUS_DIR="$TMP_DIR/status"
MOCK_LOG="$TMP_DIR/mock-upstream.log"
PROXY_LOG="$TMP_DIR/bun-proxy.log"

mkdir -p "$RESPONSES_DIR" "$ERRORS_DIR" "$STATUS_DIR"

MOCK_PID=""
PROXY_PID=""
PROBE_PROXY_PID=""
MOCK_PORT=""
PROXY_PORT=""

stop_process() {
	local pid="${1:-}"
	if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	fi
}

cleanup() {
	stop_process "$PROBE_PROXY_PID"
	stop_process "$PROXY_PID"
	stop_process "$MOCK_PID"
	rm -rf "$TMP_DIR"
}

trap cleanup EXIT INT TERM

wait_for_banner() {
	local log_file="$1"
	local prefix="$2"
	local output_var="$3"
	local timeout_seconds="$4"
	local attempts=$((timeout_seconds * 20))

	while ((attempts > 0)); do
		if [[ -f "$log_file" ]]; then
			local line
			line=$(grep -E "^${prefix}[0-9]+$" "$log_file" | tail -n 1 || true)
			if [[ -n "$line" ]]; then
				printf -v "$output_var" '%s' "${line#${prefix}}"
				return 0
			fi
		fi

		attempts=$((attempts - 1))
		sleep 0.05
	done

	return 1
}

count_matches() {
	local pattern="$1"
	shift
	if [[ "$#" -eq 0 ]]; then
		printf '0\n'
		return 0
	fi

	local matches
	matches=$(grep -Rho -- "$pattern" "$@" 2>/dev/null || true)
	if [[ -z "$matches" ]]; then
		printf '0\n'
		return 0
	fi

	printf '%s\n' "$matches" | wc -l | tr -d ' '
}

refresh_proxy_bundle() {
	bun x esbuild "$ROOT_DIR/src/bun-proxy.ts" \
		--bundle \
		--format=esm \
		--platform=node \
		--target=node20 \
		'--external:node:*' \
		--outfile="$ROOT_DIR/dist/bun-proxy.mjs" >/dev/null 2>&1
}

start_mock_upstream() {
	node "$ROOT_DIR/scripts/mock-upstream.js" >"$MOCK_LOG" 2>&1 &
	MOCK_PID=$!

	if ! wait_for_banner "$MOCK_LOG" "MOCK_UPSTREAM_PORT=" MOCK_PORT 10; then
		printf 'Failed to read MOCK_UPSTREAM_PORT banner.\n' >&2
		cat "$MOCK_LOG" >&2 || true
		exit 1
	fi
}

start_proxy_with_runtime() {
	local runtime="$1"

	HTTP_PROXY="http://127.0.0.1:${MOCK_PORT}" \
		http_proxy="http://127.0.0.1:${MOCK_PORT}" \
		HTTPS_PROXY="" \
		https_proxy="" \
		NO_PROXY="" \
		no_proxy="" \
		"$runtime" "$ROOT_DIR/dist/bun-proxy.mjs" --parent-pid=$$ >"$PROXY_LOG" 2>&1 &
	PROXY_PID=$!

	if wait_for_banner "$PROXY_LOG" "BUN_PROXY_PORT=" PROXY_PORT 5; then
		return 0
	fi

	stop_process "$PROXY_PID"
	PROXY_PID=""
	PROXY_PORT=""
	return 1
}

start_proxy() {
	: >"$PROXY_LOG"

	if start_proxy_with_runtime node; then
		return 0
	fi

	if start_proxy_with_runtime bun; then
		return 0
	fi

	printf 'Failed to start bun-proxy.\n' >&2
	cat "$PROXY_LOG" >&2 || true
	exit 1
}

fire_request() {
	local request_id="$1"
	local response_file="$RESPONSES_DIR/${request_id}.sse"
	local error_file="$ERRORS_DIR/${request_id}.log"
	local status_file="$STATUS_DIR/${request_id}.status"
	local payload

	printf -v payload '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":"parallel request %s"}],"metadata":{"request_id":"qa-%s"}}' "$request_id" "$request_id"

	local status
	status=$(curl -sS -o "$response_file" -w '%{http_code}' \
		--max-time 15 \
		-X POST "http://127.0.0.1:${PROXY_PORT}/v1/messages" \
		-H 'content-type: application/json' \
		-H 'accept: text/event-stream' \
		-H 'x-proxy-url: http://api.anthropic.com/v1/messages' \
		--data "$payload" 2>"$error_file") || status="curl:$?"

	printf '%s\n' "$status" >"$status_file"
}

run_parallel_requests() {
	seq 1 "$REQUEST_COUNT" | xargs -P "$REQUEST_COUNT" -I {} bash -c '
    request_id="$1"
    responses_dir="$2"
    errors_dir="$3"
    status_dir="$4"
    proxy_port="$5"
    response_file="$responses_dir/${request_id}.sse"
    error_file="$errors_dir/${request_id}.log"
    status_file="$status_dir/${request_id}.status"
    payload=$(printf "{\"model\":\"claude-sonnet-4-5\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"parallel request %s\"}],\"metadata\":{\"request_id\":\"qa-%s\"}}" "$request_id" "$request_id")
    status=$(curl -sS -o "$response_file" -w "%{http_code}" \
      --max-time 15 \
      -X POST "http://127.0.0.1:${proxy_port}/v1/messages" \
      -H "content-type: application/json" \
      -H "accept: text/event-stream" \
      -H "x-proxy-url: http://api.anthropic.com/v1/messages" \
      --data "$payload" 2>"$error_file") || status="curl:$?"
    printf "%s\n" "$status" >"$status_file"
  ' _ {} "$RESPONSES_DIR" "$ERRORS_DIR" "$STATUS_DIR" "$PROXY_PORT"
}

verify_parent_death() {
	local probe_log="$TMP_DIR/probe.log"
	local impossible_parent_pid=99999999

	HTTP_PROXY="http://127.0.0.1:${MOCK_PORT}" \
		http_proxy="http://127.0.0.1:${MOCK_PORT}" \
		HTTPS_PROXY="" \
		https_proxy="" \
		NO_PROXY="" \
		no_proxy="" \
		bun "$ROOT_DIR/dist/bun-proxy.mjs" --parent-pid="$impossible_parent_pid" >"$probe_log" 2>&1 &
	PROBE_PROXY_PID=$!

	if ! wait_for_banner "$probe_log" "BUN_PROXY_PORT=" _ 5; then
		stop_process "$PROBE_PROXY_PID"
		PROBE_PROXY_PID=""
		return 1
	fi

	attempts=240
	while ((attempts > 0)); do
		if ! kill -0 "$PROBE_PROXY_PID" 2>/dev/null; then
			PROBE_PROXY_PID=""
			return 0
		fi

		attempts=$((attempts - 1))
		sleep 0.05
	done

	return 1
}

refresh_proxy_bundle
start_mock_upstream
start_proxy
run_parallel_requests

message_stop_count=$(count_matches '"type":"message_stop"' "$RESPONSES_DIR")
orphans=$(count_matches 'tool_use ids were found without tool_result' "$RESPONSES_DIR" "$ERRORS_DIR" "$MOCK_LOG" "$PROXY_LOG")
connect_errors=$(count_matches 'Unable to connect' "$RESPONSES_DIR" "$ERRORS_DIR" "$MOCK_LOG" "$PROXY_LOG")
bad_statuses=$( (grep -Rhv '^200$' "$STATUS_DIR" 2>/dev/null || true) | wc -l | tr -d ' ')

parent_death_ok="N"
if verify_parent_death; then
	parent_death_ok="Y"
fi

pass="N"
if [[ "$message_stop_count" == "$REQUEST_COUNT" && "$orphans" == "0" && "$connect_errors" == "0" && "$bad_statuses" == "0" && "$parent_death_ok" == "Y" ]]; then
	pass="Y"
fi

trap - EXIT INT TERM
cleanup

if [[ "$pass" == "Y" ]]; then
	printf 'PASS | requests=%s | orphans=%s | connect_errors=%s | parent_death_ok=%s\n' "$REQUEST_COUNT" "$orphans" "$connect_errors" "$parent_death_ok"
	exit 0
fi

printf 'FAIL | requests=%s | message_stop=%s | orphans=%s | connect_errors=%s | bad_statuses=%s | parent_death_ok=%s\n' "$REQUEST_COUNT" "$message_stop_count" "$orphans" "$connect_errors" "$bad_statuses" "$parent_death_ok" >&2
exit 1
