/**
 * Shared types + constants for the memory extension. Type-only so src helpers
 * and their tests can inject a fake filesystem without importing node:fs, and
 * so index.ts stays the sole owner of the pi ExtensionAPI + node bindings.
 */

/** Kind of memory a topic holds. Drives grouping in the index + recall weights. */
export type MemoryType = "user" | "feedback" | "project" | "reference";

/** All valid memory types, in canonical display order. */
export const MEMORY_TYPES: readonly MemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
];

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

/** A topic's frontmatter header (name/description/type). */
export interface TopicMeta {
  name: string;
  description: string;
  type: MemoryType;
}

/** A memory topic file, fully parsed: frontmatter meta + markdown body + path. */
export interface ParsedTopic extends TopicMeta {
  /** Absolute path of the topic .md file. */
  path: string;
  /** Body markdown with the frontmatter block removed. */
  body: string;
}

/** One row of the MEMORY.md index (may be lighter than a fully parsed topic). */
export interface IndexEntry {
  name: string;
  description: string;
  type: MemoryType;
  /** Memory-dir-relative path to the topic file (e.g. "coding-style.md"). */
  path: string;
}

/**
 * Minimal filesystem surface used by every src helper. index.ts backs this with
 * node:fs; tests pass an in-memory fake. Read ops throw ENOENT-style when
 * missing; write ops create parent dirs as needed via mkdir.
 */
export interface FsLike {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /** Create a directory (recursively). No-op when it already exists. */
  mkdir(path: string): void;
  exists(path: string): boolean;
  readdir(path: string): Array<{ name: string; isDirectory: boolean }>;
}

/** CustomMessage.customType used for the injected (display:false) block. */
export const CUSTOM_TYPE = "memory";

/** CLI flag / kill-switch name. Default true; PI_MEMORY=0 also disables. */
export const FLAG = "memory";

/** Directory (under the scope root) that holds all memory files. */
export const MEMORY_DIRNAME = ".pi/memory";

/** Off-repo fallback lives under the shared agent dir, matching mcp/plugin-loader. */
export const AGENT_MEMORY_SUBDIR = ".pi/agent/memory";

/** The human + model facing index file. */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

/** Recall budgets (tuning knobs — see risks in the build plan). */
export const RECALL_MAX_TOPICS_PER_TURN = 2;
/** Hard UTF-8 budgets, including truncation notices and metadata. */
export const MEMORY_INDEX_MAX_BYTES = 2 * 1024;
export const MEMORY_INJECTION_MAX_BYTES = 8 * 1024;
/** Per-topic body byte cap when recalled into context. */
export const RECALL_TOPIC_MAX_BYTES = 2 * 1024;
/** Session cumulative cap on distinct topics ever recalled. */
export const SESSION_MAX_RECALL_TOPICS = 6;
/** Minimum keyword length considered for recall scoring. */
export const MIN_KEYWORD_LENGTH = 3;
