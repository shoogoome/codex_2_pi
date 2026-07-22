// Pure variable substitution for plugin resources.
//
// Claude plugins reference their own root via the CLAUDE_PLUGIN_ROOT variable,
// written either as `${CLAUDE_PLUGIN_ROOT}` or bare `$CLAUDE_PLUGIN_ROOT`. This
// module rewrites those occurrences to a plugin's real absolute root. Only
// CLAUDE_PLUGIN_ROOT is implemented this phase; other Claude vars
// (${user_config.X}, CLAUDE_PLUGIN_DATA, secrets) are left intact.

export const CLAUDE_PLUGIN_ROOT_VAR = "CLAUDE_PLUGIN_ROOT";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace `${KEY}` and bare `$KEY` occurrences of each provided variable with
 * its value. No-op for non-strings, empty strings, or strings without any
 * placeholder. `${KEY}` is replaced before bare `$KEY` so a braced form is
 * never left half-substituted.
 */
export function substituteVars(text: unknown, vars: Record<string, string>): unknown {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split("${" + key + "}").join(value);
    // Bare `$KEY` not immediately followed by a word char (so
    // `$CLAUDE_PLUGIN_ROOT_X` is left alone — `_` is a word char).
    out = out.replace(new RegExp("\\$" + escapeRegExp(key) + "\\b", "g"), value);
  }
  return out;
}

/**
 * Recursively substitute vars through strings nested in arrays/objects. Returns
 * a new structure; the input is not mutated. Non-container, non-string values
 * pass through unchanged.
 */
export function substituteDeep(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return substituteVars(value, vars);
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v, vars);
    }
    return out;
  }
  return value;
}

/** Convenience: build the standard vars record for a plugin root. */
export function pluginVars(root: string): Record<string, string> {
  return { [CLAUDE_PLUGIN_ROOT_VAR]: root };
}
