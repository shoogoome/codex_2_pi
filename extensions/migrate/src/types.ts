// Shared type-only definitions for the migrate extension. No runtime values —
// every src/ module stays pure and unit-testable; index.ts supplies the fs impl.

/**
 * Minimal filesystem facade injected by index.ts (node:fs backed). Kept in sync
 * with the shape plugin-loader/mcp use so the pure core never touches real I/O.
 */
export interface FsFacade {
  existsSync(p: string): boolean;
  readFileSync(p: string): string;
  readdirSync(p: string): string[];
  isDirectory(p: string): boolean;
}

/** Which upstream tool a config came from. */
export type SourceKind = "claude" | "cursor";

/** User-global (~/.claude) vs project-local (<cwd>/.claude). */
export type SourceScope = "user" | "project";

/** The categories migrate can bridge into pi. */
export type MigrationCategory = "mcp" | "agents" | "commands" | "hooks" | "memory";

export const MIGRATION_CATEGORIES: readonly MigrationCategory[] = [
  "mcp",
  "agents",
  "commands",
  "hooks",
  "memory",
] as const;

/** A stdio-launched MCP server (Claude-compatible shape reused by pi). */
export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** An HTTP/SSE MCP server. */
export interface McpHttpConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** A single detected source root and the known files/dirs present under it. */
export interface DetectedSource {
  kind: SourceKind;
  scope: SourceScope;
  /** Absolute path of the root (~/.claude, <cwd>/.cursor, …). */
  root: string;
  /** Absolute paths of the interesting entries found under the root. */
  files: {
    settings?: string;
    settingsLocal?: string;
    mcpJson?: string;
    agentsDir?: string;
    commandsDir?: string;
    hooksJson?: string;
    memory?: string;
    rulesDir?: string;
  };
}

/** A parsed MCP server entry with provenance for preview. */
export interface ParsedMcpServer {
  name: string;
  config: McpServerConfig;
  origin: string;
}

/** A parsed subagent definition (Claude `.claude/agents/*.md`). */
export interface ParsedAgent {
  name: string;
  description?: string;
  /** Raw comma-separated tools string, if present. */
  tools?: string;
  model?: string;
  body: string;
  origin: string;
}

/** A parsed slash command (Claude command markdown under `.claude/commands/`). */
export interface ParsedCommand {
  /** Path relative to the commands/ dir (may contain sub-dirs). */
  relPath: string;
  source: string;
  origin: string;
}

/** A single flattened hook triple for stable dedup + reconstruction. */
export interface ParsedHook {
  event: string;
  matcher?: string;
  hookType: string;
  command: string;
  origin: string;
}

/** An informational memory file (CLAUDE.md / Cursor rules). */
export interface ParsedMemory {
  path: string;
  note: string;
}

/** A per-file parse warning (never fatal). */
export interface ParseWarning {
  file: string;
  message: string;
}

/** Everything parsed out of every source, ready for planning. */
export interface ParsedConfig {
  mcpServers: ParsedMcpServer[];
  agents: ParsedAgent[];
  commands: ParsedCommand[];
  hooks: ParsedHook[];
  memory: ParsedMemory[];
  warnings: ParseWarning[];
}

/** Discriminated payload carrying what index.ts needs to apply one item. */
export type ItemPayload =
  | { kind: "mcp"; serverName: string; config: McpServerConfig; hasSecrets: boolean }
  | { kind: "agent"; content: string }
  | { kind: "prompt"; content: string }
  | { kind: "hook"; event: string; matcher?: string; hookType: string; command: string }
  | { kind: "memory" };

/** One planned migration item. */
export interface MigrationItem {
  category: MigrationCategory;
  /** Stable identity used in the plan/preview (server name, filename, …). */
  name: string;
  targetPath: string;
  action: "create" | "skip";
  skipReason?: string;
  /** Short human-readable preview line. */
  preview: string;
  payload: ItemPayload;
}

/** The full migration plan across all categories. */
export interface MigrationPlan {
  items: MigrationItem[];
  warnings: ParseWarning[];
}
