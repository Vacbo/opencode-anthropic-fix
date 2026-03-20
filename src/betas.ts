import {
  ADVANCED_TOOL_USE_BETA_FLAG,
  BEDROCK_UNSUPPORTED_BETAS,
  BETA_SHORTCUTS,
  CLAUDE_CODE_BETA_FLAG,
  EFFORT_BETA_FLAG,
  EXPERIMENTAL_BETA_FLAGS,
  FAST_MODE_BETA_FLAG,
  TOKEN_COUNTING_BETA_FLAG,
} from "./constants.js";
import { isTruthyEnv } from "./env.js";
import {
  hasOneMillionContext,
  isHaikuModel,
  isOpus46Model,
  supportsStructuredOutputs,
  supportsThinking,
  supportsWebSearch,
} from "./models.js";
import type { AccountSelectionStrategy, Provider } from "./types.js";

function isNonInteractiveMode(): boolean {
  if (isTruthyEnv(process.env.CI)) return true;
  return !process.stdout.isTTY;
}

export function buildAnthropicBetaHeader(
  incomingBeta: string,
  signatureEnabled: boolean,
  model: string,
  provider: Provider,
  customBetas: string[] | undefined,
  strategy: AccountSelectionStrategy | undefined,
  requestPath: string | undefined,
  hasFileReferences: boolean,
): string {
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  const betas: string[] = ["oauth-2025-04-20"];
  const disableExperimentalBetas = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const isMessagesCountTokensPath = requestPath === "/v1/messages/count_tokens";
  const isFilesEndpoint = requestPath?.startsWith("/v1/files") ?? false;

  if (!signatureEnabled) {
    betas.push("interleaved-thinking-2025-05-14");
    if (isMessagesCountTokensPath) {
      betas.push(TOKEN_COUNTING_BETA_FLAG);
    }
    let mergedBetas = [...new Set([...betas, ...incomingBetasList])];
    if (disableExperimentalBetas) {
      mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
    }
    return mergedBetas.join(",");
  }

  const nonInteractive = isNonInteractiveMode();
  const haiku = isHaikuModel(model);
  const isRoundRobin = strategy === "round-robin";

  if (!haiku) {
    betas.push(CLAUDE_CODE_BETA_FLAG);
  }

  // Files API beta is endpoint/content-scoped instead of globally applied.
  if ((isFilesEndpoint || hasFileReferences) && !disableExperimentalBetas) {
    betas.push("files-api-2025-04-14");
  }

  // NOTE: redact-thinking-2026-02-12 is in upstream 2.1.79+ base profile but
  // intentionally NOT auto-included here — OpenCode users benefit from seeing
  // thinking blocks. Available via /anthropic betas add redact-thinking-2026-02-12.

  // Advanced tool use improvements — in upstream 2.1.79+ base profile.
  if (!disableExperimentalBetas) {
    betas.push(ADVANCED_TOOL_USE_BETA_FLAG);
  }

  // Fast mode — in upstream 2.1.79+ base profile.
  if (!disableExperimentalBetas) {
    betas.push(FAST_MODE_BETA_FLAG);
  }

  if (isOpus46Model(model)) {
    // Opus 4.6 uses effort-based thinking controls.
    betas.push(EFFORT_BETA_FLAG);
  } else if (
    !disableExperimentalBetas &&
    !isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING) &&
    supportsThinking(model)
  ) {
    betas.push("interleaved-thinking-2025-05-14");
  }

  // context-1m-2025-08-07 is only supported for API key users; OAuth provider does not support it.
  // For OAuth (this plugin's only auth mode), compaction is gated by model.limit.input instead.
  if (!disableExperimentalBetas && hasOneMillionContext(model) && provider !== "anthropic") {
    betas.push("context-1m-2025-08-07");
  }

  if (
    !disableExperimentalBetas &&
    nonInteractive &&
    (isTruthyEnv(process.env.USE_API_CONTEXT_MANAGEMENT) || isTruthyEnv(process.env.TENGU_MARBLE_ANVIL))
  ) {
    betas.push("context-management-2025-06-27");
  }

  if (!disableExperimentalBetas && supportsStructuredOutputs(model) && isTruthyEnv(process.env.TENGU_TOOL_PEAR)) {
    betas.push("structured-outputs-2025-12-15");
  }

  if (!disableExperimentalBetas && nonInteractive && isTruthyEnv(process.env.TENGU_SCARF_COFFEE)) {
    betas.push("tool-examples-2025-10-29");
  }

  if (!disableExperimentalBetas && (provider === "vertex" || provider === "foundry") && supportsWebSearch(model)) {
    betas.push("web-search-2025-03-05");
  }

  // Prompt caching is per-workspace (since Feb 2026); round-robin across accounts
  // means zero cache hits and doubled token costs. Skip in round-robin.
  if (!disableExperimentalBetas && nonInteractive && !isRoundRobin) {
    betas.push("prompt-caching-scope-2026-01-05");
  }

  if (isMessagesCountTokensPath) {
    betas.push(TOKEN_COUNTING_BETA_FLAG);
  }

  if (process.env.ANTHROPIC_BETAS) {
    const envBetas = process.env.ANTHROPIC_BETAS.split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    betas.push(...envBetas);
  }

  if (Array.isArray(customBetas)) {
    betas.push(...customBetas.filter(Boolean));
  }

  let mergedBetas = [...new Set([...betas, ...incomingBetasList])];
  if (disableExperimentalBetas) {
    mergedBetas = mergedBetas.filter((beta) => !EXPERIMENTAL_BETA_FLAGS.has(beta));
  }
  if (provider === "bedrock") {
    return mergedBetas.filter((beta) => !BEDROCK_UNSUPPORTED_BETAS.has(beta)).join(",");
  }
  return mergedBetas.join(",");
}

/**
 * Resolve a beta shortcut alias to its full beta name.
 * Falls back to the original value if no shortcut is found.
 */
export function resolveBetaShortcut(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  const mapped = BETA_SHORTCUTS.get(trimmed.toLowerCase());
  return mapped || trimmed;
}
