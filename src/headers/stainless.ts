import { STAINLESS_HELPER_KEYS } from "../constants.js";

export function getStainlessOs(value: NodeJS.Platform): string {
  if (value === "darwin") return "MacOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  return value;
}

export function getStainlessArch(value: string): string {
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  return value;
}

export function buildStainlessHelperHeader(tools: unknown[], messages: unknown[]): string {
  const helpers = new Set<string>();

  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;

    for (const key of STAINLESS_HELPER_KEYS) {
      if (typeof obj[key] === "string" && obj[key]) {
        helpers.add(obj[key] as string);
      }
    }

    if (Array.isArray(obj.content)) {
      for (const contentBlock of obj.content) {
        collect(contentBlock);
      }
    }
  };

  for (const tool of tools) collect(tool);
  for (const message of messages) collect(message);

  return Array.from(helpers).join(", ");
}
