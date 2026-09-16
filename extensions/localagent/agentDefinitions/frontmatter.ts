import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentSource } from "../types.js";

export type ParseAgentResult =
  | { ok: true; def: AgentDefinition }
  | { ok: false; error: string };

const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);

export function parseAgentMarkdown(
  content: string,
  source: AgentSource,
  filename: string,
): ParseAgentResult {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (e) {
    return { ok: false, error: `parseFrontmatter failed: ${(e as Error).message}` };
  }
  const fm = parsed.frontmatter ?? {};
  if (Object.keys(fm).length === 0) {
    return { ok: false, error: "no frontmatter found" };
  }

  const agentType = fm.agentType;
  if (typeof agentType !== "string" || !agentType) {
    return { ok: false, error: "agentType (string) is required" };
  }
  const whenToUse = fm.whenToUse;
  if (typeof whenToUse !== "string" || !whenToUse) {
    return { ok: false, error: "whenToUse (string) is required" };
  }

  let model: AgentDefinition["model"] | undefined;
  if (fm.model !== undefined) {
    if (typeof fm.model !== "string" || !ALLOWED_MODELS.has(fm.model)) {
      return { ok: false, error: `model must be sonnet|opus|haiku|inherit, got ${String(fm.model)}` };
    }
    model = fm.model as AgentDefinition["model"];
  }

  const tools = stringArrayOrUndef(fm.tools);
  const disallowedTools = stringArrayOrUndef(fm.disallowedTools);
  const background = typeof fm.background === "boolean" ? fm.background : undefined;
  const maxTurns = typeof fm.maxTurns === "number" ? fm.maxTurns : undefined;
  const description = typeof fm.description === "string" ? fm.description : undefined;

  return {
    ok: true,
    def: {
      agentType,
      whenToUse,
      tools,
      disallowedTools,
      model,
      background,
      maxTurns,
      description,
      source,
      filename,
      systemPrompt: parsed.body.trim() === "" ? "" : parsed.body.trimEnd().replace(/^\n+/, ""),
    },
  };
}

function stringArrayOrUndef(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}
