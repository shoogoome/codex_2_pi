// Shared type-only definitions for the plugin-loader extension.
//
// These describe the subset of the Claude PluginManifest we understand plus the
// internal shapes produced by discovery. Everything here is compile-time only;
// no runtime values live in this module.

/** A single command declared inline in the manifest `commands` field. */
export interface CommandEntry {
  /** Command name (present when declared via the record form). */
  name?: string;
  /** Relative path to a markdown file, if declared via `source`. */
  source?: string;
  /** Inline markdown body, if declared via `content`. */
  content?: string;
  /** Description override. */
  description?: string;
  /** Argument hint, e.g. "<file>". */
  argumentHint?: string;
  /** Tools allowed when the command runs (Claude-only concept). */
  allowedTools?: string[];
  /** Default model for the command (Claude-only concept). */
  model?: string;
}

/** Normalized MCP server declarations from a manifest. */
export interface McpServersSpec {
  /** Inline server configs keyed by server name. */
  inline: Record<string, unknown>;
  /** Relative paths to external `.json` / `.mcpb` configs. */
  paths: string[];
}

/** The subset of a Claude PluginManifest that plugin-loader consumes. */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** Extra commands declared in the manifest (beyond the commands/ dir). */
  commands: CommandEntry[];
  /** Extra agent file paths (deferred — surfaced but not wired). */
  agents: string[];
  /** Extra skill directory paths (beyond the skills/ dir). */
  skills: string[];
  /** Extra output-style file/dir paths (beyond output-styles/). */
  outputStyles: string[];
  /** Normalized MCP server declarations. */
  mcpServers: McpServersSpec;
  /** Raw hooks declaration (deferred — surfaced but not wired). */
  hooks?: unknown;
}

/** Convention directories / files detected under a plugin root. */
export interface PluginDirs {
  commands?: string;
  skills?: string;
  themes?: string;
  outputStyles?: string;
  agents?: string;
  hooksJson?: string;
  mcpJson?: string;
}

/** A plugin discovered on disk. */
export interface DiscoveredPlugin {
  name: string;
  root: string;
  manifest: PluginManifest;
  /** Path to the manifest file that was read, if any. */
  manifestPath?: string;
  /** Which of the manifest probe paths matched (for diagnostics). */
  manifestKind?: "pi" | "claude" | "cursor" | "none";
  dirs: PluginDirs;
}

/** One MCP server registration payload handed to the mcp extension. */
export interface McpRegistration {
  name: string;
  config: unknown;
}

/** A parsed output style. */
export interface OutputStyle {
  /** Identifier derived from the source filename (without extension). */
  id: string;
  /** `name` field from frontmatter, if present. */
  name?: string;
  description?: string;
  body: string;
  /** Owning plugin name, for reporting. */
  plugin?: string;
}

/** Minimal shape read off a session branch for enable/disable reduction. */
export interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
