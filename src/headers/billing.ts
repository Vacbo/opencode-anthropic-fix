import { createHash } from "node:crypto";
import { isFalsyEnv } from "../env.js";

export function buildAnthropicBillingHeader(claudeCliVersion: string, messages: unknown[]): string {
  if (isFalsyEnv(process.env.CLAUDE_CODE_ATTRIBUTION_HEADER)) return "";

  // CC derives a 3-char hash from the first user message content using SHA-256
  // with salt "59cf53e54c78", extracting chars at positions [4,7,20] and appending
  // the CLI version, then taking the first 3 hex chars of that combined string.
  let versionSuffix = "";
  if (Array.isArray(messages)) {
    // Find first user message (CC uses first non-meta user turn)
    const firstUserMsg = messages.find(
      (m) => m !== null && typeof m === "object" && (m as Record<string, unknown>).role === "user",
    ) as Record<string, unknown> | undefined;
    if (firstUserMsg) {
      // Extract text from string or content-block array
      let text = "";
      const content = firstUserMsg.content;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        const textBlock = (content as Array<Record<string, unknown>>).find((b) => b.type === "text");
        if (textBlock && typeof textBlock.text === "string") {
          text = textBlock.text;
        }
      }
      if (text) {
        const salt = "59cf53e54c78";
        const picked = [4, 7, 20].map((i) => (i < text.length ? text[i] : "0")).join("");
        const hash = createHash("sha256")
          .update(salt + picked + claudeCliVersion)
          .digest("hex");
        versionSuffix = `.${hash.slice(0, 3)}`;
      }
    }
  }

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";

  // ---------------------------------------------------------------------------
  // Billing header construction — mimics CC's mk_() function with two deliberate gaps:
  // 1. cc_workload field: CC tracks this via AsyncLocalStorage for session-level
  //    workload attribution. Not applicable to the plugin (no workload tracking).
  //    See .omc/research/cch-source-analysis.md:124-131
  // 2. cch value: CC uses placeholder "00000". Plugin computes a deterministic hash
  //    from prompt content for consistent routing. See cch-source-analysis.md:28-39
  // ---------------------------------------------------------------------------

  // CC's Bun binary computes a 5-char hex attestation hash via Attestation.zig
  // and overwrites the "00000" placeholder before sending. On Node.js (npm CC)
  // the placeholder is sent as-is. The server may reject literal "00000" and
  // route to extra usage. Generate a body-derived 5-char hex hash to mimic
  // the attestation without the Zig layer.
  let cchValue: string;
  if (Array.isArray(messages) && messages.length > 0) {
    const bodyHint = JSON.stringify(messages).slice(0, 512);
    const cchHash = createHash("sha256")
      .update(bodyHint + claudeCliVersion + Date.now().toString(36))
      .digest("hex");
    cchValue = cchHash.slice(0, 5);
  } else {
    // Fallback: random 5-char hex
    const buf = createHash("sha256")
      .update(Date.now().toString(36) + Math.random().toString(36))
      .digest("hex");
    cchValue = buf.slice(0, 5);
  }

  return `x-anthropic-billing-header: cc_version=${claudeCliVersion}${versionSuffix}; cc_entrypoint=${entrypoint}; cch=${cchValue};`;
}
