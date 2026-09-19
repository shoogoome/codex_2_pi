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
  // Leader-only stop-loss. A teammate must not be able to abort another
  // teammate's turn — and role tools resolve from `tools: ["*"]`, so without
  // this entry the tool would leak in via TASK-role definitions.
  "teammate_interrupt",
]);

/**
 * Collaboration tools every teammate gets, in addition to its role tools.
 *
 * Lives here because spawn AND hydrate both need it; when the two lists were
 * written out separately they could drift, and a resumed teammate would
 * silently lose a tool it had before the restart.
 */
export const TEAMMATE_COLLABORATION_TOOLS = [
  "send_message",
  "team_roster",
  "request_plan_approval",
  "team_task_create",
  "team_task_update",
  "team_task_list",
  "team_task_get",
  // Background execution. Teammates are the side most likely to block on a long
  // poll (`for i in 1..8; do sleep 25; done`) and thereby become unable to read
  // leader messages — which the leader then misreads as "unresponsive".
  // async_bash turns that into submit-and-return.
  "async_bash",
  "async_status",
  "async_kill",
] as const;

export function filterTeammateTools(allTools: readonly string[]): string[] {
  return allTools.filter((name) => !TEAMMATE_TOOLS_BLOCKLIST.has(name));
}
