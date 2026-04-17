const LEGACY_TOOL_PREFIX = "mcp_";

const NATIVE_WIRE_NAME_BY_INTERNAL: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    glob: "Glob",
    grep: "Grep",
    edit: "Edit",
    write: "Write",
    skill: "Skill",
};

const INTERNAL_NAME_BY_NATIVE_WIRE = Object.fromEntries(
    Object.entries(NATIVE_WIRE_NAME_BY_INTERNAL).map(([internalName, wireName]) => [wireName, internalName]),
) as Record<string, string>;

const PRESERVED_WIRE_NAMES = new Set(["advisor", "tool_search_tool_regex"]);

export function detectLegacyDoublePrefix(name: string): boolean {
    return name.startsWith(`${LEGACY_TOOL_PREFIX}${LEGACY_TOOL_PREFIX}`);
}

function stripLegacyPrefix(name: string): string {
    return name.startsWith(LEGACY_TOOL_PREFIX) ? name.slice(LEGACY_TOOL_PREFIX.length) : name;
}

function toPascalCaseAlias(name: string): string {
    return name
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
}

function fromPascalCaseAlias(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .toLowerCase();
}

export function toWireToolName(name: string): string {
    if (detectLegacyDoublePrefix(name)) {
        throw new TypeError(`Double tool prefix detected: ${LEGACY_TOOL_PREFIX}${LEGACY_TOOL_PREFIX}`);
    }

    const normalized = stripLegacyPrefix(name);
    if (PRESERVED_WIRE_NAMES.has(normalized)) {
        return normalized;
    }

    return NATIVE_WIRE_NAME_BY_INTERNAL[normalized] ?? toPascalCaseAlias(normalized);
}

export function toInternalToolName(name: string): string {
    if (name.startsWith(LEGACY_TOOL_PREFIX)) {
        return name.slice(LEGACY_TOOL_PREFIX.length);
    }

    if (PRESERVED_WIRE_NAMES.has(name)) {
        return name;
    }

    return INTERNAL_NAME_BY_NATIVE_WIRE[name] ?? fromPascalCaseAlias(name);
}
