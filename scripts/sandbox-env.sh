#!/usr/bin/env bash
# shellcheck shell=bash
#
# Source this file to activate the sandbox environment in the current shell.
#
#   source scripts/sandbox-env.sh
#
# Overrides XDG paths, prepends the sandbox bin dir to PATH, and enables plugin
# debug logging. Does NOT affect ~/.config/opencode/ or other user state.

if [ -n "${BASH_SOURCE[0]:-}" ]; then
    _sandbox_script_source="${BASH_SOURCE[0]}"
elif [ -n "${ZSH_ARGZERO:-}" ]; then
    _sandbox_script_source="${(%):-%x}"
else
    _sandbox_script_source="${0}"
fi

_sandbox_script_dir=$(cd "$(dirname -- "${_sandbox_script_source}")" && pwd)
_sandbox_repo_root=$(cd "${_sandbox_script_dir}/.." && pwd)

SANDBOX_ROOT="${SANDBOX_ROOT:-${_sandbox_repo_root}/.sandbox}"
export SANDBOX_ROOT
export XDG_CONFIG_HOME="${SANDBOX_ROOT}/config"
export XDG_DATA_HOME="${SANDBOX_ROOT}/data"
export XDG_CACHE_HOME="${SANDBOX_ROOT}/cache"
export PATH="${SANDBOX_ROOT}/bin:${PATH}"
export OPENCODE_ANTHROPIC_DEBUG="${OPENCODE_ANTHROPIC_DEBUG:-1}"

unset _sandbox_script_source _sandbox_script_dir _sandbox_repo_root

echo "Sandbox activated: ${SANDBOX_ROOT}"
echo "  XDG_CONFIG_HOME=${XDG_CONFIG_HOME}"
echo "  XDG_DATA_HOME=${XDG_DATA_HOME}"
echo "  XDG_CACHE_HOME=${XDG_CACHE_HOME}"
echo "  OPENCODE_ANTHROPIC_DEBUG=${OPENCODE_ANTHROPIC_DEBUG}"
