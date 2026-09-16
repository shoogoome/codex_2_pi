import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeammateHandle } from "../../handle.js";
import type { TeammateIdentity } from "../../types.js";
import { buildTeamTaskCreateTool } from "./teamTaskCreate.js";
import { buildTeamTaskGetTool } from "./teamTaskGet.js";
import { buildTeamTaskListTool } from "./teamTaskList.js";
import { buildTeamTaskUpdateTool } from "./teamTaskUpdate.js";
import type { TeamTaskToolBinding } from "./teamTaskBinding.js";

/**
 * Build the four collaboration tools as leader-realm custom tools.
 *
 * Each teammate AgentSession loads extensions in an isolated module realm, so
 * its generic team_task_* definitions point at a different TeammateHandle.
 * These definitions capture the real leader handle/pi and the teammate's
 * identity. Mutations therefore hit the shared leader store and persist into
 * the leader jsonl, while reads/writes are constrained to identity.teamName.
 */
export function buildTeammateTeamTaskTools(
  pi: ExtensionAPI,
  handle: TeammateHandle,
  identity: TeammateIdentity,
) {
  const binding: TeamTaskToolBinding = { handle, identity };
  return [
    buildTeamTaskCreateTool(pi, binding),
    buildTeamTaskUpdateTool(pi, binding),
    buildTeamTaskListTool(pi, binding),
    buildTeamTaskGetTool(pi, binding),
  ];
}
