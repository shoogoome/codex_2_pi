// Tool whitelist parsing + resolution of a role's effective tool set.
// Mirrors localagent/toolPool.ts semantics so both extensions agree.

import type { AgentRole } from "./types.js";

const SAFE_DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
/** Never grant these to a role (recursion / self-reference hard-stop). */
const NEVER_INCLUDE = ["task_agent", "agents"] as const;

/**
 * Parse a frontmatter `tools`/`disallowedTools` value into a string[].
 *   - array of strings → the cleaned array
 *   - comma-separated string → split & cleaned
 *   - undefined / null → undefined (means "not specified" → safe default)
 *   - empty string → [] (explicitly no tools)
 * "*" is preserved in the array (means "all tools"); resolveRoleTools expands it.
 */
export function parseToolWhitelist(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  let list: string[];
  if (Array.isArray(v)) {
    if (!v.every((x) => typeof x === "string")) return undefined;
    list = v.map((x) => x.trim()).filter((x) => x.length > 0);
  } else if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return [];
    list = trimmed
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  } else {
    return undefined;
  }
  return Array.from(new Set(list));
}

/**
 * Resolve the effective tool whitelist for a role.
 *   - role.tools undefined → safe defaults (read-only)
 *   - role.tools contains "*" → expand to allRegistered
 *   - role.tools = [...] → use as-is (empty array → locked down)
 *   - apply disallowedTools blacklist
 *   - ALWAYS remove task_agent / agents (prevent recursion & self-invocation)
 */
export function resolveRoleTools(
  role: Pick<AgentRole, "tools" | "disallowedTools">,
  allRegistered: readonly string[],
): string[] {
  let tools: string[];
  if (role.tools === undefined) {
    tools = [...SAFE_DEFAULT_TOOLS];
  } else if (role.tools.includes("*")) {
    tools = [...allRegistered];
  } else {
    tools = [...role.tools];
  }
  if (role.disallowedTools?.length) {
    const black = new Set(role.disallowedTools);
    tools = tools.filter((t) => !black.has(t));
  }
  const never = new Set<string>(NEVER_INCLUDE);
  tools = tools.filter((t) => !never.has(t));
  return Array.from(new Set(tools));
}
