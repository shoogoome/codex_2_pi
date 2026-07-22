// Pure command mapping: a Claude command .md → a pi prompt-template .md.
// Mirrors plugin-loader/src/commandTransform.ts:
//   - keep `description` + `argument-hint` frontmatter
//   - drop `allowed-tools` / `model`
//   - rewrite `$ARGUMENTS` → `$@`, preserve `$1`/`$2`/`$@`
//   - nested command dirs → namespaced filename joined by `:` then `_`

export interface ParsedFrontmatter {
  attrs: Record<string, string>;
  body: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse a leading `--- ... ---` block of flat `key: value` scalars. */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { attrs: {}, body: source };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return { attrs: {}, body: source };
  }
  const block = normalized.slice(4, end);
  let rest = normalized.slice(end + 4);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  const attrs: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = unquote(line.slice(idx + 1));
    if (key) attrs[key] = value;
  }
  return { attrs, body: rest };
}

/**
 * Namespaced template name from a path relative to the commands/ dir.
 * `git/commit.md` → `git_commit`; `a/b/c.md` → `a:b_c`. Directory segments are
 * joined with `:`, and the final `dir:file` boundary uses `_` to match the
 * plugin-loader convention (namespacedName joins plugin + command with `_`).
 */
export function templateName(relPath: string): string {
  const noExt = relPath.replace(/\.md$/i, "");
  const segments = noExt.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length <= 1) return segments[0] ?? "command";
  const file = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  return `${dirs.join(":")}_${file}`;
}

export interface MappedCommand {
  /** Target filename inside .pi/prompts/, e.g. "git_commit.md". */
  filename: string;
  /** Template name (filename without extension) — the /name it registers. */
  name: string;
  content: string;
}

/** Transform a Claude command markdown into a pi prompt template. */
export function mapCommand(relPath: string, source: string): MappedCommand {
  const { attrs, body } = parseFrontmatter(source);
  const description = attrs.description;
  const argumentHint = attrs["argument-hint"] ?? attrs.argumentHint;

  const outBody = body.replace(/\$ARGUMENTS\b/g, "$@");

  const fmLines: string[] = [];
  if (description) fmLines.push(`description: ${description}`);
  if (argumentHint) fmLines.push(`argument-hint: ${argumentHint}`);

  const content = fmLines.length > 0 ? `---\n${fmLines.join("\n")}\n---\n${outBody}` : outBody;
  const name = templateName(relPath);
  return { filename: `${name}.md`, name, content };
}
