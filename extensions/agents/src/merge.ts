// Merge + realpath de-dup. Pure logic (realpath resolution done by caller).

import type { AgentRole } from "./types.js";

/** Priority rank; higher wins on agentType conflict. */
const SOURCE_RANK: Record<AgentRole["source"], number> = {
  "built-in": 0,
  user: 1,
  project: 2,
};

/**
 * Merge role layers. Priority: project > user > built-in. For each agentType
 * the highest-priority definition wins entirely (no field-level merge).
 */
export function mergeRoles(
  builtIn: AgentRole[],
  user: AgentRole[],
  project: AgentRole[],
): AgentRole[] {
  const map = new Map<string, AgentRole>();
  for (const r of builtIn) map.set(r.agentType, r);
  for (const r of user) map.set(r.agentType, r);
  for (const r of project) map.set(r.agentType, r);
  return Array.from(map.values());
}

export interface RealpathEntry {
  role: AgentRole;
  realpath: string;
}

/**
 * De-dup by realpath: if the same underlying file is reached via multiple
 * source dirs (e.g. a symlink), keep only the highest-priority source.
 * Roles with an empty realpath (e.g. built-ins) are always kept.
 */
export function dedupeByRealpath(entries: RealpathEntry[]): AgentRole[] {
  const best = new Map<string, RealpathEntry>();
  const passthrough: AgentRole[] = [];
  for (const e of entries) {
    if (!e.realpath) {
      passthrough.push(e.role);
      continue;
    }
    const prev = best.get(e.realpath);
    if (!prev || SOURCE_RANK[e.role.source] >= SOURCE_RANK[prev.role.source]) {
      best.set(e.realpath, e);
    }
  }
  return [...passthrough, ...Array.from(best.values()).map((e) => e.role)];
}

export function getRole(defs: AgentRole[], agentType: string): AgentRole | undefined {
  return defs.find((d) => d.agentType === agentType);
}
