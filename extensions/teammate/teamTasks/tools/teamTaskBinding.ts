import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTeammateHandle, type TeammateHandle } from "../../handle.js";
import type { TeammateIdentity } from "../../types.js";

/**
 * Leader-realm dependencies captured by the custom team_task_* tools injected
 * into an isolated teammate sub-session. The identity is deliberately carried
 * in the closure: sub-session extension realms have their own handle and ALS.
 */
export interface TeamTaskToolBinding {
  handle: TeammateHandle;
  identity: TeammateIdentity;
}

export function resolveTeamTaskHandle(
  pi: ExtensionAPI,
  binding: TeamTaskToolBinding | undefined,
): TeammateHandle {
  return binding?.handle ?? getTeammateHandle(pi);
}

export function canAccessTeam(
  binding: TeamTaskToolBinding | undefined,
  teamName: string,
): boolean {
  return binding === undefined || binding.identity.teamName === teamName;
}

export function teamAccessError(
  binding: TeamTaskToolBinding,
  requestedTeam: string,
): string {
  return (
    `Teammate '${binding.identity.agentId}' may only access team ` +
    `'${binding.identity.teamName}', not '${requestedTeam}'`
  );
}

/**
 * A teammate must not create cross-team reverse references through blocked_by.
 * Unknown ids retain the existing store semantics (they are ignored for the
 * reverse edge); ids known to belong to another team are rejected.
 */
export function findCrossTeamBlocker(
  handle: TeammateHandle,
  teamName: string,
  blockedBy: readonly string[],
): string | undefined {
  return blockedBy.find((id) => {
    const task = handle.teamTaskStore.getTask(id);
    return task !== undefined && task.teamName !== teamName;
  });
}
