// Pure output-style parsing + systemPrompt assembly.
//
// Claude output-styles are markdown files with optional `name`/`description`
// frontmatter and a body that becomes (or extends) the system prompt. pi does
// not have a native output-style slot, so plugin-loader applies a selected
// style during before_agent_start by returning a systemPrompt string.

import { parseFrontmatter } from "./commandTransform.js";
import { pluginVars, substituteVars } from "./vars.js";
import type { OutputStyle } from "./types.js";

export type OutputStyleMode = "append" | "replace";

/**
 * Parse an output-style markdown file. `id` is the filename stem; the frontmatter
 * `name` (if any) is preferred for selection. CLAUDE_PLUGIN_ROOT is substituted
 * in the body when a pluginRoot is provided.
 */
export function parseOutputStyle(id: string, source: string, pluginRoot?: string): OutputStyle {
  const { attrs, body } = parseFrontmatter(source);
  const resolvedBody = pluginRoot
    ? String(substituteVars(body, pluginVars(pluginRoot)))
    : body;
  return {
    id,
    name: attrs.name,
    description: attrs.description,
    body: resolvedBody.trim(),
  };
}

/**
 * Select an output style by name/id. Matching is by frontmatter `name` first,
 * then by `id`. Returns undefined when `selected` is empty or nothing matches.
 */
export function selectOutputStyle(
  styles: OutputStyle[],
  selected: string | undefined,
): OutputStyle | undefined {
  if (!selected) return undefined;
  return (
    styles.find((s) => s.name === selected) ?? styles.find((s) => s.id === selected)
  );
}

/**
 * Build the effective system prompt for a turn. In "append" mode the style is
 * concatenated after the base prompt; in "replace" mode it stands alone.
 */
export function buildSystemPrompt(
  base: string,
  style: OutputStyle,
  mode: OutputStyleMode,
): string {
  if (mode === "replace") return style.body;
  if (!style.body) return base;
  return `${base}\n\n${style.body}`;
}
