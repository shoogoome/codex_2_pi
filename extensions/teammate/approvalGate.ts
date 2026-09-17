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
import { planApprovalTimeoutMs } from "./protocol.js";
import type { TeammateIdentity } from "./types.js";

interface ApprovalSessionState {
  identity: TeammateIdentity;
  approved: boolean;
  approvalGeneration: number;
}

interface ApprovalGateRegistry {
  sessions: Map<string, ApprovalSessionState>;
  context: AsyncLocalStorage<string>;
  /**
   * Session ids known to be the LEADER, which must never be gated. Kept in the
   * process-global registry (not a module-level Set) because teammate
   * AgentSessions load this extension in isolated jiti module realms: a
   * module-scoped Set would be written in the leader's realm and read as EMPTY
   * from the realm where the tool_call hook actually runs, silently disabling
   * the exemption. That exact mistake shipped once and the leader's own writes
   * kept being blocked under a teammate's name.
   */
  leaderSessionIds: Set<string>;
}

const REGISTRY_KEY = Symbol.for("pi.teammate.approvalGate");

function registry(): ApprovalGateRegistry {
  const target = globalThis as unknown as Record<symbol, ApprovalGateRegistry | undefined>;
  let value = target[REGISTRY_KEY];
  if (!value) {
    value = {
      sessions: new Map(),
      context: new AsyncLocalStorage<string>(),
      leaderSessionIds: new Set<string>(),
    };
    target[REGISTRY_KEY] = value;
  } else {
    // Defensive for an in-process extension reload from an older shape (the
    // pre-context registry, or one predating the leader exemption).
    if (!value.context) value.context = new AsyncLocalStorage<string>();
    if (!value.leaderSessionIds) value.leaderSessionIds = new Set<string>();
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

/**
 * Run `fn` with the approval ALS context DETACHED.
 *
 * Why this is required — a cross-session leak that stalls the whole pipeline:
 *
 *   1. A teammate turn is tagged via `runWithApprovalSession(id, …)` so its own
 *      mutating tools can be gated by session id.
 *   2. That teammate calls `request_plan_approval`, whose delivery path reaches
 *      `pi.sendMessage(…, { triggerTurn: true })`.
 *   3. When the leader is idle that call takes the `await this._runAgentPrompt(…)`
 *      branch (pi 0.85.0 agent-session.js L1120) — so the LEADER's entire turn is
 *      started, and therefore runs, INSIDE the teammate's async context.
 *   4. `getCurrentApprovalSessionId()` then reports the teammate for every tool
 *      call the leader makes in that turn, and the leader's own writes are
 *      rejected as that teammate.
 *
 * Observed for real: the leader's `edit` of `.vibegame/plan.md` and read-only
 * `ls` / `find` / `sleep` bash calls were blocked as "architect@forge" and
 * "reviewer@forge" across two sessions. The leader could not write anything.
 *
 * `AsyncLocalStorage.exit()` drops the store for the synchronous scope it wraps
 * while keeping the async resources it starts usable. Delivery must therefore
 * happen inside `exit()`: the leader's turn must not inherit a teammate's
 * identity. Anything the leader starts from there schedules on the ambient
 * (store-less) context again.
 */
export function runWithoutApprovalSession<T>(fn: () => T): T {
  return registry().context.exit(fn);
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

/**
 * Leader session ids, which must NEVER be gated.
 *
 * Why this exists — the AsyncLocalStorage store is inherited down the whole
 * async chain a teammate prompt creates, and in-process teammates share one
 * Node process with the leader. pi's `tool_call` hook is registered at the
 * extension-factory top level, so it runs for the LEADER too; when a leader tool
 * call happens to be scheduled from within a chain that a teammate turn rooted,
 * `getCurrentApprovalSessionId()` resolves to that teammate and the leader's own
 * write is blocked under the teammate's name.
 *
 * Observed for real: a leader's `edit` of `.vibegame/plan.md` (a file only the
 * leader owns) and even read-only `ls`/`find` bash calls were rejected with
 * "reviewer@forge must call request_plan_approval …" 25 times in one session —
 * the leader could not write anything, stalling the whole pipeline. The hook's
 * comment used to claim "Leader calls have no approval context and are
 * unaffected"; that assumption is false under ALS inheritance.
 *
 * Registering leader ids lets the gate refuse to gate them, which is the one
 * thing we can assert locally: the leader is never a teammate, regardless of what
 * the ambient store says.
 */
/** Register a session id as the (single) leader so it can never be gated. */
export function registerLeaderSession(sessionId: string): void {
  registry().leaderSessionIds.add(sessionId);
}

export function unregisterLeaderSession(sessionId: string): void {
  registry().leaderSessionIds.delete(sessionId);
}

/**
 * Whether a tool call attributed to `sessionId` should be gated.
 *
 * Returns false for the leader: the ambient store can be inherited from a
 * teammate turn, so attribution alone is not trustworthy evidence that the
 * caller IS that teammate.
 */
export function shouldGateToolCall(sessionId: string | undefined): sessionId is string {
  if (!sessionId) return false;
  if (registry().leaderSessionIds.has(sessionId)) return false;
  // No registered approval session means this id was never a teammate.
  return registry().sessions.has(sessionId);
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
  if (toolName === "bash" || toolName === "task_bash" || toolName === "async_bash") {
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
  // Spell out the mechanism, not just the requirement. Teammates previously
  // had to read the pi dist source and guess when "this turn" expires before
  // they could escape the block; state the unlock path, the lifetime, and the
  // fallback so a stuck teammate can recover without lore.
  return (
    `${agent} must call request_plan_approval {plan: "..."} and receive leader ` +
    "approval before using a mutating tool. Approval covers the remainder of " +
    "THIS turn only; it is revoked when the turn ends. If the leader does not " +
    `answer within ${Math.round(planApprovalTimeoutMs() / 60000)} minute(s) the request ` +
    "times out — then report the blocker with send_message instead of retrying writes, " +
    "and do not end the turn expecting the gate to reopen by itself."
  );
}

/** Test-only. */
export function _resetApprovalGateForTest(): void {
  registry().sessions.clear();
  registry().leaderSessionIds.clear();
  registry().context.disable();
  registry().context = new AsyncLocalStorage<string>();
  _resetAgentMutationPauseForTest();
}
