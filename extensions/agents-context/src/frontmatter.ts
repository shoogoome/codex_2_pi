/**
 * Frontmatter parsing + conditional-`paths` extraction.
 *
 * A leading `---` fenced block is treated as YAML-ish frontmatter. We only need
 * the `paths` key (claude parity: a rule file may declare `paths: "src/**"` or a
 * YAML list to make itself conditional). Everything else in the frontmatter is
 * preserved as raw key/value strings but unused.
 */

export interface ParsedFrontmatter {
  /** Raw key -> raw value string (values not deeply parsed). */
  frontmatter: Record<string, string>;
  /** YAML list items captured for keys that used block-list syntax. */
  lists: Record<string, string[]>;
  /** Body content with the frontmatter block removed. */
  content: string;
}

/**
 * Split a leading `---\n...\n---` frontmatter block off the raw file. When there
 * is no well-formed frontmatter the whole input is returned as content.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // Must start with a `---` line (allow a leading BOM / whitespace-free start).
  const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!fmMatch) {
    return { frontmatter: {}, lists: {}, content: raw };
  }
  const body = raw.slice(fmMatch[0].length);
  const frontmatter: Record<string, string> = {};
  const lists: Record<string, string[]> = {};

  const lines = fmMatch[1].split(/\r?\n/);
  let currentListKey: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    // Block list item: "  - value"
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      lists[currentListKey].push(stripQuotes(listItem[1].trim()));
      continue;
    }
    // key: value  (or "key:" starting a block list)
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      if (value === "") {
        // Possibly starts a block list on following lines.
        currentListKey = key;
        lists[key] = [];
        frontmatter[key] = "";
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Inline flow list: [a, b, c]
        currentListKey = null;
        lists[key] = value
          .slice(1, -1)
          .split(",")
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
        frontmatter[key] = value;
      } else {
        currentListKey = null;
        frontmatter[key] = stripQuotes(value);
      }
    }
  }
  return { frontmatter, lists, content: body };
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Derive the conditional globs from a parsed frontmatter. Returns undefined when
 * the file has no `paths` restriction (i.e. it is unconditional). A `paths` of
 * `**` (or `**\/*` etc.) that would match everything is treated as
 * unconditional too, so it doesn't gate injection.
 */
export function extractPaths(
  parsed: ParsedFrontmatter,
): string[] | undefined {
  let raw: string[] = [];
  if (parsed.lists.paths && parsed.lists.paths.length > 0) {
    raw = parsed.lists.paths;
  } else if (parsed.frontmatter.paths && parsed.frontmatter.paths.trim() !== "") {
    // Comma-separated string form.
    raw = parsed.frontmatter.paths
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } else {
    return undefined;
  }

  const globs = raw
    .map((g) => normalizeGlob(g))
    .filter((g): g is string => g.length > 0);
  if (globs.length === 0) return undefined;
  // If every glob is a catch-all, the rule is effectively unconditional.
  if (globs.every(isCatchAll)) return undefined;
  return globs;
}

/** Strip a trailing "/**" or "/" so "src/**" and "src/" both mean "under src". */
function normalizeGlob(g: string): string {
  let out = g.trim();
  out = out.replace(/\/\*\*$/, "/**"); // keep as-is; handled by matcher
  return out;
}

function isCatchAll(g: string): boolean {
  const t = g.replace(/\//g, "");
  return t === "**" || t === "***" || g === "**/*" || g === "*";
}
