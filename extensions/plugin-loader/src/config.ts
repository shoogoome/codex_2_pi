// Pure enable/disable reducer over session custom entries. Mirrors the approvals
// extension's reduceRuleEntries pattern: index.ts persists a toggle via
// pi.appendEntry and replays the branch on session_start to derive state.

import type { EntryLike } from "./types.js";

export const PLUGIN_TOGGLE_ENTRY = "plugin_toggle";

/** Coerce entry data into a { name, enabled } toggle, or null. */
function coerceToggle(data: unknown): { name: string; enabled: boolean } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.name !== "string" || d.name.length === 0) return null;
  if (typeof d.enabled !== "boolean") return null;
  return { name: d.name, enabled: d.enabled };
}

/**
 * Replay plugin_toggle entries in branch order → name → enabled map. Later
 * entries win. Unknown/malformed entries are ignored. Plugins not present in
 * the map are enabled by default.
 */
export function reduceToggles(entries: EntryLike[]): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PLUGIN_TOGGLE_ENTRY) continue;
    const toggle = coerceToggle(entry.data);
    if (toggle) map.set(toggle.name, toggle.enabled);
  }
  return map;
}

/** A plugin is enabled unless an entry explicitly disabled it. */
export function isEnabled(name: string, toggles: Map<string, boolean>): boolean {
  return toggles.get(name) ?? true;
}
