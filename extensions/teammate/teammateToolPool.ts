// teammateToolPool.ts
//
// Tool pool computation for teammate sub-sessions. Two concerns:
//   1. Recursion guards (D1): keep teammates from spawning more teammates.
//   2. Permission Path B (D2 §4.2): keep write-class tools off teammates;
//      they must request leader to perform writes/bash/edits via
//      send_message. See specs/2026-06-03-d2-teammate-leader-cooperation.md.
//
// Both spawnTeammate (fresh spawn) and hydrate.respawnTeammates (resume after
// session restart) use this so the constant lives in one place.

export const TEAMMATE_TOOLS_BLOCKLIST = new Set<string>([
  // recursion guards (D1)
  "task_agent",
  "team_create",
  "team_delete",
  // D2 Module C (permission sync, Path B) — write-class tools.
  "bash",
  "write",
  "edit",
  "task_bash",
  "task_kill",
]);

export function filterTeammateTools(allTools: readonly string[]): string[] {
  return allTools.filter((name) => !TEAMMATE_TOOLS_BLOCKLIST.has(name));
}
