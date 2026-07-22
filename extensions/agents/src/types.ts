// Role types for the agents extension. Field names deliberately mirror
// localagent/types.ts (agentType/whenToUse) so a future integration with the
// task_agent subagent mechanism is a drop-in — even though we load from
// Claude-style frontmatter (name/description) and map at the parse layer.

export type AgentSource = "built-in" | "user" | "project";

export type AgentModel = "sonnet" | "opus" | "haiku" | "inherit";

/** Display-only color whitelist (pi exports no AGENT_COLORS constant). */
export const AGENT_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "cyan",
  "gray",
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

export interface AgentRole {
  /** Unique name (from frontmatter `name`). Also the subagent_type literal. */
  agentType: string;
  /** From frontmatter `description`. Helps a parent LLM pick this role. */
  whenToUse: string;
  /** Explicit tool whitelist. undefined → safe default; may originate from "*" (all). */
  tools?: string[];
  /** Blacklist, applied on top of `tools`. */
  disallowedTools?: string[];
  model?: AgentModel;
  color?: AgentColor;
  background?: boolean;
  maxTurns?: number;
  source: AgentSource;
  /** Basename of the .md file this role was loaded from (disk roles only). */
  filename?: string;
  /** Directory the file was found in (disk roles only). */
  baseDir?: string;
  /** The sub-session system prompt (frontmatter body). */
  systemPrompt: string;
}

/** A file that failed to parse into a role, with the reason. */
export interface FailedFile {
  source: AgentSource;
  filename: string;
  baseDir: string;
  error: string;
}
