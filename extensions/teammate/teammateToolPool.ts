// teammateToolPool.ts
//
// Tool pool computation for teammate sub-sessions. Currently only the
// recursion guards are blocklisted: keep teammates from spawning more
// teammates / managing teams. Write-class tools (bash/write/edit/...)
// remain available — same default as claudecode sub-agents. Teammate
// is expected to call request_plan_approval before destructive
// operations (see teammatePromptBoilerplate).
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
