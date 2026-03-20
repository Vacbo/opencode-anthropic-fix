// ---------------------------------------------------------------------------
// Shared TypeScript types used across the plugin modules
// ---------------------------------------------------------------------------

export type ThinkingEffort = "low" | "medium" | "high";

export type Provider = "anthropic" | "bedrock" | "vertex" | "foundry";

export type PromptCompactionMode = "minimal" | "off";

export type AccountSelectionStrategy = "round-robin" | "sequential" | string;

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SystemBlock {
  type: string;
  text: string;
  cache_control?: { type: string };
}

export interface SignatureConfig {
  enabled: boolean;
  claudeCliVersion: string;
  promptCompactionMode: PromptCompactionMode;
  strategy?: AccountSelectionStrategy;
  customBetas?: string[];
}

export interface RuntimeContext {
  persistentUserId: string;
  sessionId: string;
  accountId: string;
}

export interface RequestBodyMetadata {
  model: string;
  tools: unknown[];
  messages: unknown[];
  hasFileReferences: boolean;
}

export interface RequestMetadata {
  user_id: string;
  organization_uuid?: string;
  user_email?: string;
}
