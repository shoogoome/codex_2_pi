// Pure transform from a Claude command markdown file to a pi prompt template.
//
// pi prompt templates: filename → /name, frontmatter supports `description` and
// `argument-hint`, and the body may use $1, $@, ${@:N}, $ARGUMENTS. Claude
// commands additionally carry `allowed-tools` and `model` frontmatter that pi
// has no prompt-template equivalent for, so those are dropped (surfaced only in
// docs). CLAUDE_PLUGIN_ROOT in the body is substituted to the real root.

import { pluginVars, substituteVars } from "./vars.js";

export interface ParsedFrontmatter {
  attrs: Record<string, string>;
  body: string;
}

/** Strip surrounding single/double quotes from a scalar value. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse a leading `--- ... ---` YAML-ish frontmatter block. Only flat
 * `key: value` scalars are understood (enough for command metadata). When no
 * frontmatter is present, attrs is empty and the whole source is the body.
 */
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
  // Body starts after the closing `---` line.
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

/** Namespaced prompt template filename base for a plugin command. */
export function namespacedName(pluginName: string, commandName: string): string {
  return `${pluginName}_${commandName}`;
}

export interface TransformInput {
  pluginName: string;
  commandName: string;
  source: string;
  pluginRoot: string;
}

export interface TransformOutput {
  filename: string;
  content: string;
}

/**
 * Transform a Claude command markdown into a pi prompt template.
 * - keeps `description` and `argument-hint` frontmatter (drops allowed-tools/model)
 * - normalizes `$ARGUMENTS` → `$@` (both valid in pi; keep one form)
 * - preserves positional `$1`, `$2`, … and `$@`
 * - substitutes `${CLAUDE_PLUGIN_ROOT}` / `$CLAUDE_PLUGIN_ROOT` in the body
 */
export function transformCommand(input: TransformInput): TransformOutput {
  const { pluginName, commandName, source, pluginRoot } = input;
  const { attrs, body } = parseFrontmatter(source);

  const description = attrs.description;
  const argumentHint = attrs["argument-hint"] ?? attrs.argumentHint;

  let outBody = String(substituteVars(body, pluginVars(pluginRoot)));
  outBody = outBody.replace(/\$ARGUMENTS\b/g, "$@");

  const fmLines: string[] = [];
  if (description) fmLines.push(`description: ${description}`);
  if (argumentHint) fmLines.push(`argument-hint: ${argumentHint}`);

  const content =
    fmLines.length > 0 ? `---\n${fmLines.join("\n")}\n---\n${outBody}` : outBody;

  return {
    filename: `${namespacedName(pluginName, commandName)}.md`,
    content,
  };
}
