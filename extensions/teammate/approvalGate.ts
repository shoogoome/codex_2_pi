// Process-global teammate mutation-approval gate.
//
// Teammate AgentSessions load extensions in isolated module realms, so an
// approval granted by the leader-bound request_plan_approval custom tool cannot
// be shared through a normal module singleton. globalThis is shared across
// those realms (the same mechanism used by leaderBridge).

import { AsyncLocalStorage } from "node:async_hooks";
import {
  isWriteBashCommand,
  isWriteTool,
} from "../plan-mode/src/guard.js";
import {
  _resetAgentMutationPauseForTest,
  getAgentMutationPause,
} from "../shared/agentMutationPause.js";
import type { TeammateIdentity } from "./types.js";

interface ApprovalSessionState {
  identity: TeammateIdentity;
  approved: boolean;
  approvalGeneration: number;
}

interface ApprovalGateRegistry {
  sessions: Map<string, ApprovalSessionState>;
  context: AsyncLocalStorage<string>;
}

const REGISTRY_KEY = Symbol.for("pi.teammate.approvalGate");

function registry(): ApprovalGateRegistry {
  const target = globalThis as unknown as Record<symbol, ApprovalGateRegistry | undefined>;
  let value = target[REGISTRY_KEY];
  if (!value) {
    value = { sessions: new Map(), context: new AsyncLocalStorage<string>() };
    target[REGISTRY_KEY] = value;
  } else if (!value.context) {
    // Defensive for an in-process extension reload from the pre-context shape.
    value.context = new AsyncLocalStorage<string>();
  }
  return value;
}

export function registerApprovalSession(
  sessionId: string,
  identity: TeammateIdentity,
): void {
  registry().sessions.set(sessionId, {
    identity,
    approved: false,
    approvalGeneration: getAgentMutationPause().generation,
  });
}

export function unregisterApprovalSession(sessionId: string): void {
  registry().sessions.delete(sessionId);
}

export function grantApproval(sessionId: string): boolean {
  const session = registry().sessions.get(sessionId);
  const pause = getAgentMutationPause();
  if (!session || pause.paused) return false;
  session.approved = true;
  session.approvalGeneration = pause.generation;
  return true;
}

/** Approval is scoped to one teammate turn; entering idle revokes it. */
export function revokeApproval(sessionId: string): void {
  const state = registry().sessions.get(sessionId);
  if (state) state.approved = false;
}

export function getApprovalIdentity(sessionId: string): TeammateIdentity | undefined {
  return registry().sessions.get(sessionId)?.identity;
}

/** Bind a child prompt's async execution to its process-global approval key. */
export function runWithApprovalSession<T>(
  sessionId: string,
  fn: () => T,
): T {
  return registry().context.run(sessionId, fn);
}

/** Read by tool_call hooks loaded in isolated child extension realms. */
export function getCurrentApprovalSessionId(): string | undefined {
  return registry().context.getStore();
}

export function isMutationApproved(sessionId: string): boolean {
  const session = registry().sessions.get(sessionId);
  const pause = getAgentMutationPause();
  return session?.approved === true
    && !pause.paused
    && session.approvalGeneration === pause.generation;
}

const DIRECT_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "write_file",
  "edit_file",
  "replace",
  "create_file",
  "delete_file",
  "move_file",
]);

export function isApprovalRequiredToolCall(toolName: string, input: unknown): boolean {
  if (isWriteTool(toolName) || DIRECT_MUTATION_TOOLS.has(toolName)) return true;
  if (toolName === "bash" || toolName === "task_bash") {
    const command = typeof input === "object" && input !== null
      ? (input as { command?: unknown }).command
      : undefined;
    return typeof command === "string" && isWriteBashCommand(command);
  }
  // MCP tools have no portable read/write metadata. Requiring one explicit
  // approval per turn is safer than letting a teammate mutate remote state
  // merely because the role contains a wildcard tool grant.
  return toolName.startsWith("mcp__");
}

export function approvalBlockReason(sessionId: string): string {
  const identity = getApprovalIdentity(sessionId);
  const agent = identity?.agentId ?? "teammate";
  if (getAgentMutationPause().paused) {
    return `${agent} cannot use mutating tools while the root session is in Plan mode.`;
  }
  return (
    `${agent} must call request_plan_approval and receive leader approval ` +
    "before using a mutating tool in this turn."
  );
}

/** Test-only. */
export function _resetApprovalGateForTest(): void {
  registry().sessions.clear();
  registry().context.disable();
  registry().context = new AsyncLocalStorage<string>();
  _resetAgentMutationPauseForTest();
}
