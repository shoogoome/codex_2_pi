/**
 * Topic frontmatter parsing + rendering. A topic file is:
 *
 *   ---
 *   name: Coding style
 *   description: How the user likes code written
 *   type: user
 *   ---
 *   <markdown body>
 *
 * Adapted from agents-context/src/frontmatter.ts (fenced `---` parser), narrowed
 * to the three keys we need and with a matching renderer for writing new topics.
 */
import { isMemoryType, type MemoryType, type TopicMeta } from "./types.js";

export interface ParsedTopicFile {
  meta: TopicMeta;
  body: string;
  /** True when a well-formed frontmatter block was present. */
  hadFrontmatter: boolean;
}

/**
 * Parse a topic file's raw text. Missing/blank keys degrade gracefully: name
 * defaults to "", description to "", type to "project". The body is everything
 * after the frontmatter fence (or the whole input when there is no fence).
 */
export function parseTopicFrontmatter(raw: string): ParsedTopicFile {
  const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!fmMatch) {
    return {
      meta: { name: "", description: "", type: "project" },
      body: raw,
      hadFrontmatter: false,
    };
  }
  const body = raw.slice(fmMatch[0].length);
  const kv: Record<string, string> = {};
  for (const line of fmMatch[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (m) kv[m[1].toLowerCase()] = stripQuotes(m[2].trim());
  }
  const type: MemoryType = isMemoryType(kv.type) ? kv.type : "project";
  return {
    meta: {
      name: kv.name ?? "",
      description: kv.description ?? "",
      type,
    },
    body,
    hadFrontmatter: true,
  };
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** YAML-escape a scalar value for the frontmatter block (quote when needed). */
function renderScalar(value: string): string {
  const v = value.replace(/\r?\n/g, " ").trim();
  if (v === "" || /[:#"'\[\]{}]/.test(v) || /^[\s]/.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

/** Render a `---` frontmatter block for the given meta (trailing newline). */
export function renderFrontmatter(meta: TopicMeta): string {
  return [
    "---",
    `name: ${renderScalar(meta.name)}`,
    `description: ${renderScalar(meta.description)}`,
    `type: ${meta.type}`,
    "---",
    "",
  ].join("\n");
}

/** Render a full topic file (frontmatter + body). Ensures exactly one blank line. */
export function renderTopicFile(meta: TopicMeta, body: string): string {
  const trimmed = body.replace(/^\s+/, "").replace(/\s+$/, "");
  return `${renderFrontmatter(meta)}\n${trimmed}\n`;
}
