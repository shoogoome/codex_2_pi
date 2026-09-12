// Pure agent mapping: a parsed Claude subagent → a pi-native agent .md file.
//
// pi agent role frontmatter (consumed by extensions/agents):
//   agentType (req), whenToUse (req), description?, tools? (string[]),
//   model? ∈ {sonnet,opus,haiku,inherit}; body = systemPrompt.
// Claude agents carry: name, description, tools (comma string), model.

import type { ParsedAgent } from "./types.js";

const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);

export interface MappedAgent {
  /** Target filename inside .pi/agents/, e.g. "reviewer.md". */
  filename: string;
  content: string;
}

/** Escape a scalar for a simple `key: value` YAML line (quote if risky). */
function yamlScalar(value: string): string {
  const v = value.trim();
  if (v === "") return '""';
  if (/[:#\-?{}\[\],&*!|>'"%@`\n]/.test(v) || /^\s|\s$/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

/** Split a Claude comma-separated tools string into a clean string[]. */
export function splitTools(tools: string | undefined): string[] {
  if (!tools) return [];
  return tools
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Map a Claude model name to pi's allowed set; unknown → dropped (undefined). */
export function mapModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase();
  if (ALLOWED_MODELS.has(m)) return m;
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return undefined;
}

/** Sanitize an agent name into a safe filename base (no path separators). */
export function agentFilename(name: string): string {
  const base = name.trim().replace(/[\\/]+/g, "_").replace(/\s+/g, "-");
  return `${base}.md`;
}

/** Render a parsed Claude agent into a pi agent .md string + target filename. */
export function mapAgent(agent: ParsedAgent): MappedAgent {
  const whenToUse = agent.description?.trim() || `Migrated agent: ${agent.name}`;
  const fm: string[] = [];
  fm.push(`agentType: ${yamlScalar(agent.name)}`);
  fm.push(`whenToUse: ${yamlScalar(whenToUse)}`);
  if (agent.description?.trim()) {
    fm.push(`description: ${yamlScalar(agent.description)}`);
  }
  const tools = splitTools(agent.tools);
  if (tools.length > 0) {
    fm.push(`tools: [${tools.map((t) => yamlScalar(t)).join(", ")}]`);
  }
  const model = mapModel(agent.model);
  if (model) fm.push(`model: ${model}`);

  const body = agent.body.trim();
  const content = `---\n${fm.join("\n")}\n---\n${body ? `${body}\n` : ""}`;
  return { filename: agentFilename(agent.name), content };
}
