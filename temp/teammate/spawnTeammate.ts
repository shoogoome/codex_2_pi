// spawnTeammate — entry point for creating a long-lived in-process teammate.
//
// Mirrors the SDK injection pattern of `extensions/localagent/spawnLocalAgent.ts`:
// tests can replace `_sdk`; production resolves constructors beside the active
// Pi CLI so a stale project dev dependency cannot select the child model/auth.
//
// Lifecycle:
//   1. validate team exists + agentId not already running
//   2. create a fresh persisted SessionManager under
//      ~/.pi/agent/teammates/<team>/<agent>/
//   3. resolve the selected role's tools, add collaboration tools, and remove
//      self-spawning team controls
//   4. register the InProcessTeammateTaskState in the TaskStore
//   5. emit `teammate_spawn` event for jsonl persistence + add team member
//   6. start the teammateLoop with onTerminal wired to flip status +
//      remove member + dispose session

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPiRuntimeSdk } from "../shared/pi-runtime-sdk.js";

import type { TaskStore } from "../tasks/taskStore.js";
import type { AgentDefinition } from "../localagent/types.js";
import { GENERAL_PURPOSE_AGENT } from "../localagent/agentDefinitions/builtIn.js";
import type { AgentModel, AgentThinkingLevel } from "../localagent/model.js";
import { resolveSubAgentTools } from "../localagent/toolPool.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput, initTaskOutput } from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { createTaskStateBase, generateTaskId } from "../tasks/Task.js";
import { logError } from "../tasks/logging.js";
import { getAgentCapacity } from "../tasks/agentCapacityHandle.js";
import type {
  AgentCapacity,
  AgentCapacityLease,
} from "../tasks/agentCapacity.js";

import type { TeammateHandle } from "./handle.js";
import type { InProcessTeammateTaskState, TeammateIdentity } from "./types.js";
import { isInProcessTeammateTask } from "./types.js";
import { emitTeammateEvent } from "./eventEmit.js";
import { postLeaderNotification } from "./leaderNotification.js";
import {
  grantApproval,
  registerApprovalSession,
  revokeApproval,
  unregisterApprovalSession,
} from "./approvalGate.js";
import { fingerprintAgentDefinition } from "./roleFingerprint.js";
import { startTeammateLoop } from "./teammateLoop.js";
import { filterTeammateTools } from "./teammateToolPool.js";
import { prependBoilerplate } from "./teammatePromptBoilerplate.js";
import { subscribeTeammateProgress } from "./sessionProgress.js";
import { buildTeammateTeamTaskTools } from "./teamTasks/tools/teammateTeamTaskTools.js";
import { buildTeammateSendMessageTool } from "./tools/teammateSendMessage.js";
import {
  buildRequestPlanApprovalTool,
  type PendingApprovals,
  type PlanApprovalDecision,
} from "./tools/requestPlanApproval.js";

// ---------- SDK injection ----------

export interface TeammateSdkBindings {
  createAgentSessionServices: (opts: {
    cwd: string;
    appendSystemPrompt?: string[];
  }) => Promise<unknown>;
  SessionManagerCreate: (cwd: string, sessionDir: string) => unknown | Promise<unknown>;
  createAgentSessionFromServices: (opts: {
    services: unknown;
    sessionManager: unknown;
    tools: readonly string[];
    customTools?: readonly unknown[];
    model?: AgentModel;
    thinkingLevel?: AgentThinkingLevel;
  }) => Promise<{ session: unknown }>;
}

let _sdk: TeammateSdkBindings = {
  createAgentSessionServices: async (opts) => {
    const sdk = await loadPiRuntimeSdk();
    return sdk.createAgentSessionServices({
      cwd: opts.cwd,
      resourceLoaderOptions: opts.appendSystemPrompt?.length
        ? { appendSystemPrompt: opts.appendSystemPrompt }
        : undefined,
    }) as unknown as Promise<unknown>;
  },
  SessionManagerCreate: async (cwd, sessionDir) =>
    (await loadPiRuntimeSdk()).SessionManager.create(cwd, sessionDir),
  createAgentSessionFromServices: async (opts) => {
    const sdk = await loadPiRuntimeSdk();
    return sdk.createAgentSessionFromServices({
      services: opts.services as never,
      sessionManager: opts.sessionManager as never,
      tools: opts.tools as never,
      customTools: opts.customTools as never,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
    }) as unknown as Promise<{ session: unknown }>;
  },
};

/** Test helper — replace SDK bindings for the duration of a test. */
export function _setSdkForTest(bindings: Partial<TeammateSdkBindings>): void {
  _sdk = { ..._sdk, ...bindings };
}

// ---------- public types ----------

export interface SpawnTeammateOptions {
  teamName: string;
  agentName: string;
  agentDef?: AgentDefinition;
  /** Backward-compatible direct callers; task_agent resolves agentDef. */
  agentType?: string;
  prompt: string;
  model?: AgentModel | string;
  thinkingLevel?: AgentThinkingLevel;
  cwd: string;
  toolUseId?: string;
}

export interface SpawnTeammateResult {
  taskId: string;
  agentId: string;
  sessionFile: string;
}

// ---------- helpers ----------

const SAFE_PATH_RE = /[^a-zA-Z0-9_-]/g;
function sanitize(s: string): string {
  return s.replace(SAFE_PATH_RE, "-");
}

function findRunningTeammateByAgentId(
  taskStore: TaskStore,
  agentId: string,
): InProcessTeammateTaskState | undefined {
  for (const t of Object.values(taskStore.get())) {
    if (
      isInProcessTeammateTask(t) &&
      t.status === "running" &&
      t.identity.agentId === agentId
    ) {
      return t;
    }
  }
  return undefined;
}

// ---------- main ----------

export async function spawnTeammate(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  handle: TeammateHandle,
  opts: SpawnTeammateOptions,
): Promise<SpawnTeammateResult> {
  const capacity = getAgentCapacity(pi);
  const residentLease = capacity.reserveResident();
  try {
    return await spawnTeammateWithLease(
      pi,
      taskStore,
      handle,
      opts,
      capacity,
      residentLease,
    );
  } catch (error) {
    residentLease.release();
    throw error;
  }
}

async function spawnTeammateWithLease(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  handle: TeammateHandle,
  opts: SpawnTeammateOptions,
  capacity: AgentCapacity,
  residentLease: AgentCapacityLease,
): Promise<SpawnTeammateResult> {
  // 1. validations
  const team = handle.teamStore.getTeam(opts.teamName);
  if (!team) {
    throw new Error(
      `Team '${opts.teamName}' does not exist. Call team_create first.`,
    );
  }

  const agentId = `${opts.agentName}@${opts.teamName}`;
  if (findRunningTeammateByAgentId(taskStore, agentId)) {
    throw new Error(`Teammate '${agentId}' already exists in team.`);
  }

  // 2. SessionManager.create — fresh persisted session under ~/.pi/agent/teammates/<team>/<agent>/
  const sessionDir = join(
    homedir(),
    ".pi",
    "agent",
    "teammates",
    sanitize(opts.teamName),
    sanitize(opts.agentName),
  );
  const sm = await _sdk.SessionManagerCreate(opts.cwd, sessionDir);
  const sessionFile = (sm as { getSessionFile: () => string | undefined }).getSessionFile();
  if (!sessionFile) {
    throw new Error("SessionManager.create did not produce a session file");
  }

  // 3. Resolve identity, role prompt, and tool pool from the selected agent
  //    definition. Collaboration tools are always added; role tools still
  //    obey the same allow/deny rules as one-shot agents.
  const agentDef: AgentDefinition = opts.agentDef ?? {
    ...GENERAL_PURPOSE_AGENT,
    agentType: opts.agentType ?? GENERAL_PURPOSE_AGENT.agentType,
  };
  const resolvedModel = typeof opts.model === "object" ? opts.model : undefined;
  const identity: TeammateIdentity = {
    agentId,
    agentName: opts.agentName,
    teamName: opts.teamName,
    agentType: agentDef.agentType,
    roleFingerprint: fingerprintAgentDefinition(agentDef),
  };
  const services = await _sdk.createAgentSessionServices({
    cwd: opts.cwd,
    appendSystemPrompt: agentDef.systemPrompt
      ? [agentDef.systemPrompt]
      : undefined,
  });
  const allToolInfos = pi.getAllTools();
  const allToolNames = allToolInfos.map((t) => t.name);
  const roleTools = resolveSubAgentTools(agentDef, allToolNames);
  const collaborationTools = [
    "send_message",
    "request_plan_approval",
    "team_task_create",
    "team_task_update",
    "team_task_list",
    "team_task_get",
  ];
  const tools = filterTeammateTools([...new Set([...roleTools, ...collaborationTools])]);

  // Leader-realm map of in-flight plan_approval_request entries. Allocated
  // here (not in the teammate sub-session realm) so the request_plan_approval
  // tool's resolve() and teammateLoop's response routing share the same Map.
  // See requestPlanApproval.ts for the rationale.
  const pendingApprovalsMap = new Map<
    string,
    { resolve: (d: PlanApprovalDecision) => void; reject: (e: Error) => void }
  >();
  const pendingApprovals: PendingApprovals = {
    set: (id, entry) => {
      pendingApprovalsMap.set(id, entry);
    },
    get: (id) => pendingApprovalsMap.get(id),
    delete: (id) => {
      pendingApprovalsMap.delete(id);
    },
  };

  const { session: sessionUnknown } = await _sdk.createAgentSessionFromServices({
    services,
    sessionManager: sm,
    tools,
    customTools: [
      buildTeammateSendMessageTool(identity, {
        mailbox: handle.mailbox,
        teamStore: handle.teamStore,
        deliverToLeader: (details, triggerTurn) => {
          postLeaderNotification(pi, details, triggerTurn);
        },
        persistEvent: (event) => {
          emitTeammateEvent(pi, event);
        },
      }),
      buildRequestPlanApprovalTool({
        identity,
        pendingApprovals,
        getLeaderChannel: () => ({
          deliver: (details, triggerTurn) => {
            postLeaderNotification(pi, details, triggerTurn);
          },
        }),
        onApproved: () => grantApproval(sessionFile),
      }),
      ...buildTeammateTeamTaskTools(pi, handle, identity),
    ],
    model: resolvedModel,
    thinkingLevel: opts.thinkingLevel,
  });
  const session = sessionUnknown as AgentSession;

  // 4. register task
  const taskId = generateTaskId("in_process_teammate");
  const outputFile = getTaskOutputPath(taskId);

  const initial: InProcessTeammateTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "in_process_teammate",
      description: `${opts.agentName}@${opts.teamName}`,
      outputFile,
      toolUseId: opts.toolUseId,
    }),
    type: "in_process_teammate",
    status: "running",
    identity,
    prompt: opts.prompt,
    model: resolvedModel
      ? `${resolvedModel.provider}/${resolvedModel.id}`
      : typeof opts.model === "string"
        ? opts.model
        : undefined,
    sessionFile,
    session,
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
  };
  registerTask(initial, taskStore);

  // Init output file (fire-and-forget, EEXIST tolerated for re-spawn races).
  void initTaskOutput(taskId).catch((e: unknown) => {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: unknown }).code === "EEXIST"
    ) {
      return;
    }
    logError(e, "spawnTeammate initTaskOutput");
  });

  // 5. event + member registration
  emitTeammateEvent(pi, {
    kind: "teammate_spawn",
    identity,
    sessionFile,
    initialPrompt: opts.prompt,
  });

  handle.teamStore.addMember(opts.teamName, agentId);

  // 6. abort controller stored in task state for kill path
  const abortController = new AbortController();
  updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (cur) => ({
    ...cur,
    abortController,
    agentResidentLease: residentLease,
  }));

  // 6.5 Subscribe to session events so the panel widget gets live
  //     tokenCount / toolCallCount / lastTool updates. The teammateLoop
  //     only fires onTurnStart / onIdle, which is enough for turnCount,
  //     but the SDK's session.subscribe stream carries `message_end`
  //     (with assistant `usage.totalTokens`) and `tool_execution_start`
  //     (with `toolName`) — exactly what the widget surfaces. Without
  //     this listener tokenCount / toolCallCount stay 0 forever even
  //     though the teammate is clearly working.
  const unsubscribeSession = subscribeTeammateProgress(
    session,
    taskId,
    taskStore,
  );

  // 7. Start the teammateLoop. The boilerplate explains the role-scoped tool
  //    set and the hard request_plan_approval gate for mutating calls.
  const augmentedPrompt = prependBoilerplate(opts.prompt, identity);

  registerApprovalSession(sessionFile, identity);
  startTeammateLoop({
    identity,
    initialPrompt: augmentedPrompt,
    session,
    mailbox: handle.mailbox,
    pendingApprovals,
    agentCapacity: capacity,
    approvalSessionId: sessionFile,
    abortSignal: abortController.signal,
    onTurnStart: () => {
      // Every turn begins fail-closed. Only an approved
      // request_plan_approval call opens mutations for this turn.
      revokeApproval(sessionFile);
      // Every turn counts — including the initial one (boilerplate +
      // initialPrompt). Previously we skipped `cause.kind === "initial"`,
      // which left turnCount stuck at 0 for any teammate that runs to
      // completion in a single LLM cycle.
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        isIdle: false,
        lastError: undefined,
        turnCount: t.turnCount + 1,
      }));
    },
    onTurnResult: (text) => {
      if (!text.trim()) return;
      postLeaderNotification(
        pi,
        { kind: "result", agentId: identity.agentId, body: text },
        /* triggerTurn */ true,
      );
    },
    onTurnError: (error) => {
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        lastError: error.message,
      }));
      postLeaderNotification(
        pi,
        { kind: "turn_error", agentId: identity.agentId, error: error.message },
        /* triggerTurn */ true,
      );
    },
    onIdle: () => {
      revokeApproval(sessionFile);
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        isIdle: true,
      }));
      // Surface idle status to the leader's main LLM as an informational
      // notification. triggerTurn:false — leader sees the entry in context
      // but is not woken (claudecode pattern: idle is normal, no reaction
      // required unless the leader wants to assign new work).
      postLeaderNotification(
        pi,
        { kind: "idle", agentId: identity.agentId },
        /* triggerTurn */ false,
      );
    },
    onMessageAcknowledged: (msg) => {
      emitTeammateEvent(pi, {
        kind: "message_ack",
        messageId: msg.id,
        agentId: identity.agentId,
      });
    },
    onShutdownRequestReceived: (requestId) => {
      emitTeammateEvent(pi, {
        kind: "shutdown_request",
        agentId,
        requestId,
      });
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        shutdownRequested: true,
      }));
    },
    onShutdownAcked: (requestId, approve) => {
      emitTeammateEvent(pi, {
        kind: "shutdown_response",
        agentId,
        requestId,
        approve,
      });
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        shutdownAcknowledged: approve,
      }));
    },
    onTerminal: (reason) => {
      residentLease.release();
      unregisterApprovalSession(sessionFile);
      // Drop the session-event listener regardless of whether killTeammate
      // already handled the rest of the cleanup — we own this subscription
      // and must release it to avoid a leak. The unsubscribe is idempotent.
      unsubscribeSession();

      // If killTeammate already handled this (notified=true), it has flipped
      // status, emitted teammate_terminal, removed the member, disposed the
      // session, and evicted output. Nothing left to do — skip to avoid
      // double-emit / double-dispose races.
      const cur = taskStore.getTask(taskId) as
        | InProcessTeammateTaskState
        | undefined;
      if (cur?.notified) return;

      const terminalStatus: "completed" | "killed" =
        reason === "shutdown" ? "completed" : "killed";
      updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
        ...t,
        status: terminalStatus,
        endTime: Date.now(),
        notified: true,
      }));
      emitTeammateEvent(pi, {
        kind: "teammate_terminal",
        agentId,
        status: terminalStatus,
      });
      handle.teamStore.removeMember(opts.teamName, agentId);
      try {
        session.dispose();
      } catch (e) {
        logError(e, "spawnTeammate session.dispose");
      }
      void evictTaskOutput(taskId);
    },
  });

  return { taskId, agentId, sessionFile };
}
