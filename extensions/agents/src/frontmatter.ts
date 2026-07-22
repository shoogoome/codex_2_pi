// Claude-style frontmatter parsing. Maps name→agentType, description→whenToUse,
// body→systemPrompt. Uses pi's exported parseFrontmatter.

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AGENT_COLORS, type AgentColor, type AgentModel, type AgentRole, type AgentSource } from "./types.js";
import { parseToolWhitelist } from "./tools.js";

export type ParseRoleResult =
  | { ok: true; role: AgentRole }
  // skipped: file is intentionally not a role (no frontmatter / no name).
  | { ok: false; error: string; skip?: boolean };

const ALLOWED_MODELS = new Set<AgentModel>(["sonnet", "opus", "haiku", "inherit"]);
const COLOR_SET = new Set<string>(AGENT_COLORS);

/** Reverse the frontmatter escaping of literal "\n" sequences in descriptions. */
function unescapeNewlines(s: string): string {
  return s.replace(/\\n/g, "\n");
}

export function parseRoleMarkdown(
  content: string,
  source: AgentSource,
  filename: string,
  baseDir = "",
): ParseRoleResult {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (e) {
    return { ok: false, error: `parseFrontmatter failed: ${(e as Error).message}` };
  }
  const fm = parsed.frontmatter ?? {};
  if (Object.keys(fm).length === 0) {
    // No frontmatter at all — likely a co-located doc, not a role. Skip quietly.
    return { ok: false, error: "no frontmatter found", skip: true };
  }

  // name → agentType. Missing name = probably a co-located doc → skip quietly.
  const name = fm.name;
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "name is required", skip: true };
  }
  const agentType = name.trim();

  // description → whenToUse. Missing description IS an error (it looked like a role).
  const description = fm.description;
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, error: `agent "${agentType}" is missing a description` };
  }
  const whenToUse = unescapeNewlines(description).trim();

  let model: AgentModel | undefined;
  if (fm.model !== undefined && fm.model !== null) {
    if (typeof fm.model !== "string") {
      return { ok: false, error: `model must be a string, got ${typeof fm.model}` };
    }
    const m = fm.model.trim().toLowerCase();
    if (!ALLOWED_MODELS.has(m as AgentModel)) {
      return { ok: false, error: `model must be sonnet|opus|haiku|inherit, got "${fm.model}"` };
    }
    model = m as AgentModel;
  }

  let color: AgentColor | undefined;
  if (typeof fm.color === "string") {
    const c = fm.color.trim().toLowerCase();
    if (COLOR_SET.has(c)) color = c as AgentColor;
    // Unknown color is display-only → silently drop rather than fail the file.
  }

  const background =
    fm.background === true || fm.background === "true" ? true : undefined;

  let maxTurns: number | undefined;
  if (typeof fm.maxTurns === "number" && Number.isInteger(fm.maxTurns) && fm.maxTurns > 0) {
    maxTurns = fm.maxTurns;
  } else if (typeof fm.maxTurns === "string") {
    const n = Number(fm.maxTurns.trim());
    if (Number.isInteger(n) && n > 0) maxTurns = n;
  }

  const tools = parseToolWhitelist(fm.tools);
  const disallowedTools = parseToolWhitelist(fm.disallowedTools);

  return {
    ok: true,
    role: {
      agentType,
      whenToUse,
      tools,
      disallowedTools,
      model,
      color,
      background,
      maxTurns,
      source,
      filename,
      baseDir: baseDir || undefined,
      systemPrompt: parsed.body.trim(),
    },
  };
}
