// teammateToolPool.ts
//
// Final recursion guard for teammate sub-sessions. Role-level allow/deny
// resolution happens first in spawn/hydrate; this layer then prevents a
// teammate from creating nested teams. General-purpose roles may retain
// write-class tools, while explore/custom read-only roles do not.
//
// Both spawnTeammate (fresh spawn) and hydrate.respawnTeammates (resume
// after session restart) use this so the constant lives in one place.

export const TEAMMATE_TOOLS_BLOCKLIST = new Set<string>([
  // recursion guards (D1) — keep teammates from spawning more teammates.
  "task_agent",
  "team_create",
  "team_delete",
]);

export function filterTeammateTools(allTools: readonly string[]): string[] {
  return allTools.filter((name) => !TEAMMATE_TOOLS_BLOCKLIST.has(name));
}
