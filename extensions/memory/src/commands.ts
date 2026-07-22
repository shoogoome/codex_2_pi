/**
 * Pure command helpers for /memory and /remember. All disk IO and UI stays in
 * index.ts; these functions only compute plans (paths + file contents) and
 * format display strings, so they are trivially unit-testable.
 */
import { renderTopicFile } from "./frontmatter.js";
import { topicFileName } from "./paths.js";
import type { IndexEntry, ParsedTopic, TopicMeta } from "./types.js";
import { MEMORY_TYPES } from "./types.js";
import { join } from "node:path";

/** Default topic that free-form /remember text lands in when none is targeted. */
export const DEFAULT_REMEMBER_META: TopicMeta = {
  name: "General notes",
  description: "Miscellaneous durable facts remembered via /remember",
  type: "project",
};

/** Derive index entries from parsed topics (memory-dir-relative paths). */
export function entriesFromTopics(
  topics: ParsedTopic[],
  memoryDir: string,
): IndexEntry[] {
  const prefix = memoryDir.endsWith("/") ? memoryDir : memoryDir + "/";
  return topics.map((t) => ({
    name: t.name,
    description: t.description,
    type: t.type,
    path: t.path.startsWith(prefix) ? t.path.slice(prefix.length) : t.path,
  }));
}

/** Render a `/memory list` view grouped by type. */
export function formatList(entries: IndexEntry[]): string {
  if (entries.length === 0) {
    return "No memory topics yet. Use /remember <text> or ask me to write one.";
  }
  const lines: string[] = [];
  for (const type of MEMORY_TYPES) {
    const group = entries
      .filter((e) => e.type === type)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (group.length === 0) continue;
    lines.push(`${type}:`);
    for (const e of group) {
      const desc = e.description ? ` — ${e.description}` : "";
      lines.push(`  • ${e.name}  (${e.path})${desc}`);
    }
  }
  return lines.join("\n");
}

export type ShowResolution =
  | { ok: true; path: string; name: string }
  | { ok: false; error: string };

/**
 * Resolve a `/memory show <name>` argument to a memory-dir-relative topic path.
 * Matches by topic name (case-insensitive), then by filename/path.
 */
export function resolveShow(
  arg: string,
  entries: IndexEntry[],
): ShowResolution {
  const q = arg.trim().toLowerCase();
  if (q === "") return { ok: false, error: "Usage: /memory show <name>" };
  const byName = entries.find((e) => e.name.toLowerCase() === q);
  if (byName) return { ok: true, path: byName.path, name: byName.name };
  const byPath = entries.find(
    (e) =>
      e.path.toLowerCase() === q ||
      e.path.toLowerCase() === (q.endsWith(".md") ? q : `${q}.md`) ||
      e.path.toLowerCase().endsWith(`/${q}.md`),
  );
  if (byPath) return { ok: true, path: byPath.path, name: byPath.name };
  const partial = entries.find((e) => e.name.toLowerCase().includes(q));
  if (partial) return { ok: true, path: partial.path, name: partial.name };
  return { ok: false, error: `No memory topic matching "${arg}".` };
}

export interface RememberPlan {
  /** Absolute path of the topic file to write. */
  path: string;
  /** Full new contents of the topic file (frontmatter + body). */
  content: string;
  /** True when a brand-new topic file is being created. */
  isNew: boolean;
  /** Index entry for this topic (memory-dir-relative path). */
  entry: IndexEntry;
  /** The bullet that was appended (for UI echo). */
  bullet: string;
}

export interface RememberOptions {
  /** Injected clock for deterministic tests. Defaults to now. */
  now?: Date;
  /** Override the target topic meta (defaults to the General notes topic). */
  targetMeta?: TopicMeta;
}

/** Format the YYYY-MM-DD date prefix for a remembered bullet. */
function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Plan a /remember: append a timestamped bullet to the target topic (default
 * "General notes"), creating the topic file when it doesn't exist yet.
 */
export function buildRememberPlan(
  text: string,
  existingTopics: ParsedTopic[],
  memoryDir: string,
  opts: RememberOptions = {},
): RememberPlan {
  const meta = opts.targetMeta ?? DEFAULT_REMEMBER_META;
  const now = opts.now ?? new Date();
  const bullet = `- ${isoDate(now)}: ${text.trim()}`;

  const fileName = topicFileName(meta.name);
  const path = join(memoryDir, fileName);

  const existing = existingTopics.find(
    (t) => t.path === path || t.name.toLowerCase() === meta.name.toLowerCase(),
  );

  let body: string;
  let isNew: boolean;
  let effectiveMeta: TopicMeta;
  if (existing) {
    const trimmed = existing.body.replace(/\s+$/, "");
    body = trimmed.length > 0 ? `${trimmed}\n${bullet}` : bullet;
    isNew = false;
    effectiveMeta = {
      name: existing.name || meta.name,
      description: existing.description || meta.description,
      type: existing.type,
    };
  } else {
    body = bullet;
    isNew = true;
    effectiveMeta = meta;
  }

  return {
    path,
    content: renderTopicFile(effectiveMeta, body),
    isNew,
    entry: {
      name: effectiveMeta.name,
      description: effectiveMeta.description,
      type: effectiveMeta.type,
      path: fileName,
    },
    bullet,
  };
}
