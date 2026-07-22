// Text rendering for the /agents command. Pure strings — never touches UI.

import type { AgentRole, AgentSource, FailedFile } from "./types.js";
import { resolveRoleTools } from "./tools.js";

const SOURCE_ORDER: AgentSource[] = ["built-in", "user", "project"];
const SOURCE_HEADING: Record<AgentSource, string> = {
  "built-in": "Built-in roles",
  user: "User roles",
  project: "Project roles",
};

/** Short one-line summary of a role's declared tool whitelist. */
export function toolsSummary(role: Pick<AgentRole, "tools">): string {
  if (role.tools === undefined) return "default (read,grep,find,ls)";
  if (role.tools.includes("*")) return "* (all)";
  if (role.tools.length === 0) return "none";
  return role.tools.join(",");
}

function modelLabel(role: Pick<AgentRole, "model">): string {
  return role.model ?? "inherit";
}

/** Render the grouped role list shown by `/agents` / `/agents list`. */
export function renderRoleList(roles: AgentRole[]): string {
  if (roles.length === 0) {
    return "No agent roles found.";
  }
  const lines: string[] = [`Agent roles (${roles.length}):`];
  for (const source of SOURCE_ORDER) {
    const group = roles
      .filter((r) => r.source === source)
      .sort((a, b) => a.agentType.localeCompare(b.agentType));
    if (group.length === 0) continue;
    lines.push("", `${SOURCE_HEADING[source]}:`);
    for (const r of group) {
      lines.push(
        `  ${r.agentType}  [${r.source}]  tools=${toolsSummary(r)}  model=${modelLabel(r)}  color=${r.color ?? "-"}`,
      );
    }
  }
  return lines.join("\n");
}

/** Render the full detail view for `/agents show <name>`. */
export function renderRoleShow(role: AgentRole, allRegistered: readonly string[]): string {
  const resolved = resolveRoleTools(role, allRegistered);
  const location =
    role.source === "built-in"
      ? "(built-in)"
      : role.baseDir
        ? `${role.baseDir}/${role.filename ?? "?"}`
        : (role.filename ?? "(unknown)");
  const lines: string[] = [
    `${role.agentType}  [${role.source}]`,
    `description: ${role.whenToUse}`,
    `declared tools: ${toolsSummary(role)}`,
    `effective tools: ${resolved.length ? resolved.join(", ") : "(none)"}`,
  ];
  if (role.disallowedTools?.length) {
    lines.push(`disallowed: ${role.disallowedTools.join(", ")}`);
  }
  lines.push(
    `model: ${modelLabel(role)}`,
    `color: ${role.color ?? "-"}`,
    `background: ${role.background ? "true" : "false"}`,
    `maxTurns: ${role.maxTurns ?? "-"}`,
    `file: ${location}`,
    "",
    "system prompt:",
    role.systemPrompt,
  );
  return lines.join("\n");
}

/** Render a footer listing files that failed to parse. Empty string if none. */
export function renderFailures(failedFiles: FailedFile[]): string {
  if (failedFiles.length === 0) return "";
  const lines: string[] = ["", `Failed to load ${failedFiles.length} file(s):`];
  for (const f of failedFiles) {
    lines.push(`  ${f.baseDir}/${f.filename} [${f.source}]: ${f.error}`);
  }
  return "\n" + lines.join("\n");
}
