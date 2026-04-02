// ---------------------------------------------------------------------------
// Shared constants extracted from index.mjs
// ---------------------------------------------------------------------------

export const FALLBACK_CLAUDE_CLI_VERSION = "2.1.90";
export const CLAUDE_CODE_NPM_LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
export const CLAUDE_CODE_BETA_FLAG = "claude-code-20250219";
export const EFFORT_BETA_FLAG = "effort-2025-11-24";
export const ADVANCED_TOOL_USE_BETA_FLAG = "advanced-tool-use-2025-11-20";
export const FAST_MODE_BETA_FLAG = "fast-mode-2026-02-01";
export const TASK_BUDGETS_BETA_FLAG = "task-budgets-2026-03-13";
export const TOKEN_EFFICIENT_TOOLS_BETA_FLAG = "token-efficient-tools-2026-03-28";
export const TOKEN_COUNTING_BETA_FLAG = "token-counting-2024-11-01";
export const CLAUDE_CODE_IDENTITY_STRING = "You are Claude Code, Anthropic's official CLI for Claude.";

export const KNOWN_IDENTITY_STRINGS = new Set([
  CLAUDE_CODE_IDENTITY_STRING,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
]);

export const BEDROCK_UNSUPPORTED_BETAS = new Set([
  "interleaved-thinking-2025-05-14",
  "context-1m-2025-08-07",
  "tool-search-tool-2025-10-19",
]);

export const EXPERIMENTAL_BETA_FLAGS = new Set([
  "adaptive-thinking-2026-01-28",
  "advanced-tool-use-2025-11-20",
  "advisor-tool-2026-03-01",
  "afk-mode-2026-01-31",
  "ccr-byoc-2025-07-29",
  "ccr-triggers-2026-01-30",
  "code-execution-2025-08-25",
  "context-1m-2025-08-07",
  "context-management-2025-06-27",
  "environments-2025-11-01",
  "fast-mode-2026-02-01",
  "files-api-2025-04-14",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
  "mcp-client-2025-11-20",
  "prompt-caching-scope-2026-01-05",
  "redact-thinking-2026-02-12",
  "skills-2025-10-02",
  "structured-outputs-2025-12-15",
  "task-budgets-2026-03-13",
  "token-efficient-tools-2026-03-28",
  "tool-search-tool-2025-10-19",
  "web-search-2025-03-05",
]);

export const BETA_SHORTCUTS = new Map<string, string>([
  ["1m", "context-1m-2025-08-07"],
  ["1m-context", "context-1m-2025-08-07"],
  ["context-1m", "context-1m-2025-08-07"],
  ["fast", "fast-mode-2026-02-01"],
  ["fast-mode", "fast-mode-2026-02-01"],
  ["opus-fast", "fast-mode-2026-02-01"],
]);

export const STAINLESS_HELPER_KEYS = [
  "x_stainless_helper",
  "x-stainless-helper",
  "stainless_helper",
  "stainlessHelper",
  "_stainless_helper",
] as const;

export const USER_ID_STORAGE_FILE = "anthropic-signature-user-id";
export const DEBUG_SYSTEM_PROMPT_ENV = "OPENCODE_ANTHROPIC_DEBUG_SYSTEM_PROMPT";
export const ANTHROPIC_COMMAND_HANDLED = "__ANTHROPIC_COMMAND_HANDLED__";
export const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;
export const FOREGROUND_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export const COMPACT_TITLE_GENERATOR_SYSTEM_PROMPT = [
  "You are a title generator. You output ONLY a thread title. Nothing else.",
  "",
  "Rules:",
  "- Use the same language as the user message.",
  "- Output exactly one line.",
  "- Keep the title at or below 50 characters.",
  "- No explanations, prefixes, or suffixes.",
  "- Keep important technical terms, numbers, and filenames when present.",
].join("\n");
