// Cross-extension handle for teammate state.
//
// Pi loads each extension under its own jiti module realm, so extensions
// can't share singletons via simple module-level exports. Pi 0.84+ also
// gives each extension its own `pi.events` facade; attachSessionHandle
// publishes on the shared EventBus so localagent can resolve this handle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachSessionHandle, getSessionHandle } from "../shared/sessionHandle.js";
import type { TeamStore } from "./teamStore.js";
import type { Mailbox } from "./mailbox.js";
import type { TeamTaskStore } from "./teamTasks/teamTaskStore.js";
import type { PendingApprovals } from "./tools/requestPlanApproval.js";
import { unregisterApprovalSession } from "./approvalGate.js";

export interface TeammateHandle {
  teamStore: TeamStore;
  mailbox: Mailbox;
  teamTaskStore: TeamTaskStore;
  /**
   * Per-teammate in-flight plan approval requests, keyed by agentId.
   *
   * Registered here so `team_plan_approve` can verify the leader is answering
   * a request that actually exists. Without it the tool accepted any id — a
   * guessed `request_id` returned a success message while the teammate waited
   * forever on a response routed to nothing.
   */
  approvalRequests: {
    register(agentId: string, approvals: PendingApprovals): void;
    unregister(agentId: string): void;
    /** Pending request ids for one teammate, or undefined if it has no entry. */
    pendingIds(agentId: string): string[] | undefined;
  };
}

/** Create the approval-request registry that lives on the handle. */
export function createApprovalRequestRegistry(): TeammateHandle["approvalRequests"] {
  const byAgentId = new Map<string, PendingApprovals>();
  return {
    register: (agentId, approvals) => {
      byAgentId.set(agentId, approvals);
    },
    unregister: (agentId) => {
      byAgentId.delete(agentId);
    },
    pendingIds: (agentId) => {
      const approvals = byAgentId.get(agentId);
      return approvals ? approvals.ids() : undefined;
    },
  };
}

/**
 * Tear down every terminal-path trace of a teammate in one call.
 *
 * Terminal paths (kill, shutdown, resume failure, resume completion, spawn
 * completion) each used to remember their own subset of cleanup; forgetting one
 * leaves `team_plan_approve` answering a request for a teammate that is gone.
 * Idempotent, so callers need not care about double-teardown.
 */
export function retireTeammate(
  handle: TeammateHandle,
  identity: { teamName: string; agentId: string },
  sessionFile?: string,
): void {
  handle.approvalRequests.unregister(identity.agentId);
  handle.teamStore.removeMember(identity.teamName, identity.agentId);
  if (sessionFile !== undefined) {
    unregisterApprovalSession(sessionFile);
  }
}

const HANDLE_KEY = "teammate";

export function attachTeammateHandle(pi: ExtensionAPI, handle: TeammateHandle): void {
  attachSessionHandle(pi, HANDLE_KEY, handle);
}

export function getTeammateHandle(pi: ExtensionAPI): TeammateHandle {
  const handle = getSessionHandle<TeammateHandle>(pi, HANDLE_KEY);
  if (!handle) {
    throw new Error(
      "teammate: default TeammateHandle not initialised. Ensure pi-teammate-extension is loaded before any extension that uses it.",
    );
  }
  return handle;
}
