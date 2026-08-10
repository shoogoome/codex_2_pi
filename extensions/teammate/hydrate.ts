// hydrate — rebuild teammate state from a list of session entries.
//
// Pi exposes the parent session jsonl via ctx.sessionManager.getEntries(). We
// filter to entries that are custom messages with our customType, extract
// each one's details as a TeammateEvent, and feed them through the reducer.
//
// Defensive: malformed entries (no details, details not object, no kind field
// or non-string kind) are silently skipped. This keeps hydration robust even
// if a future code path emits a partial event.
//
// Task 4.2 wraps this with the actual respawn flow (calling SessionManager.open
// for each running teammate). Task 4.3 wires it into session_start.

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadPiRuntimeSdk } from "../shared/pi-runtime-sdk.js";

import type { TaskStore } from "../tasks/taskStore.js";
import { getBuiltInAgents } from "../localagent/agentDefinitions/builtIn.js";
import { loadAgentsFromDir } from "../localagent/agentDefinitions/loadFromDisk.js";
import { getAgentDefinition, mergeAgentDefinitions } from "../localagent/agentDefinitions/resolve.js";
import { resolveSubAgentTools } from "../localagent/toolPool.js";
import type { AgentDefinition } from "../localagent/types.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput, initTaskOutput } from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { createTaskStateBase, generateTaskId } from "../tasks/Task.js";
import { logError } from "../tasks/logging.js";
import { getAgentCapacity } from "../tasks/agentCapacityHandle.js";
import type { AgentCapacityLease } from "../tasks/agentCapacity.js";

import { TEAMMATE_EVENT_CUSTOM_TYPE, emitTeammateEvent } from "./eventEmit.js";
import { postLeaderNotification } from "./leaderNotification.js";
import {
  grantApproval,
  registerApprovalSession,
  revokeApproval,
  unregisterApprovalSession,
} from "./approvalGate.js";
import { fingerprintAgentDefinition } from "./roleFingerprint.js";
import {
  reduceTeammateEvents,
  type ReplayedState,
  type ReplayedTeammate,
} from "./jsonlEvents.js";
import type { TeammateHandle } from "./handle.js";
import { startTeammateLoop } from "./teammateLoop.js";
import { filterTeammateTools } from "./teammateToolPool.js";
import { subscribeTeammateProgress } from "./sessionProgress.js";
import { buildTeammateTeamTaskTools } from "./teamTasks/tools/teammateTeamTaskTools.js";
import { buildTeammateSendMessageTool } from "./tools/teammateSendMessage.js";
import {
  buildRequestPlanApprovalTool,
  type PendingApprovals,
  type PlanApprovalDecision,
} from "./tools/requestPlanApproval.js";
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
  type TeammateEvent,
} from "./types.js";

export interface SessionEntryLike {
  type: string;
  customType?: string;
  details?: unknown;
}

export function hydrateTeammateState(
  entries: readonly SessionEntryLike[],
): ReplayedState {
  const events: TeammateEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== TEAMMATE_EVENT_CUSTOM_TYPE) continue;
    const details = entry.details;
    if (typeof details !== "object" || details === null) continue;
    const obj = details as Record<string, unknown>;
    if (typeof obj.kind !== "string") continue;
    events.push(details as TeammateEvent);
  }
  return reduceTeammateEvents(events);
}

// ---------- Task 4.2: respawn flow ----------

export interface HydrateSdkBindings {
  createAgentSessionServices: (opts: {
    cwd: string;
    appendSystemPrompt?: string[];
  }) => Promise<unknown>;
  SessionManagerOpen: (path: string) => unknown | Promise<unknown>;
  createAgentSessionFromServices: (opts: {
    services: unknown;
    sessionManager: unknown;
    tools: readonly string[];
    customTools?: readonly unknown[];
  }) => Promise<{ session: unknown }>;
}

const _hydrateSdkDefaults: HydrateSdkBindings = {
  createAgentSessionServices: async (opts) => {
    const sdk = await loadPiRuntimeSdk();
    return sdk.createAgentSessionServices({
      cwd: opts.cwd,
      resourceLoaderOptions: opts.appendSystemPrompt?.length
        ? { appendSystemPrompt: opts.appendSystemPrompt }
        : undefined,
    }) as unknown as Promise<unknown>;
  },
  SessionManagerOpen: async (path) => (await loadPiRuntimeSdk()).SessionManager.open(path),
  createAgentSessionFromServices: async (opts) => {
    const sdk = await loadPiRuntimeSdk();
    return sdk.createAgentSessionFromServices({
      services: opts.services as never,
      sessionManager: opts.sessionManager as never,
      tools: opts.tools as never,
      customTools: opts.customTools as never,
    }) as unknown as Promise<{ session: unknown }>;
  },
};

let _hydrateSdk: HydrateSdkBindings = { ..._hydrateSdkDefaults };

/**
 * Test helper — replace SDK bindings for the duration of a test. Passing an
 * empty object resets to defaults; partial overrides only the specified keys.
 */
export function _setHydrateSdkForTest(
  bindings: Partial<HydrateSdkBindings>,
): void {
  _hydrateSdk = { ..._hydrateSdkDefaults, ...bindings };
}

export interface RespawnContext {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  handle: TeammateHandle;
  cwd: string;
}

async function createResumedAgentSession(
  replayed: ReplayedTeammate,
  agentDef: AgentDefinition,
  ctx: RespawnContext,
): Promise<{ session: AgentSession; pendingApprovals: PendingApprovals }> {
  const sm = await _hydrateSdk.SessionManagerOpen(replayed.sessionFile);
  const services = await _hydrateSdk.createAgentSessionServices({
    cwd: ctx.cwd,
    appendSystemPrompt: agentDef.systemPrompt ? [agentDef.systemPrompt] : undefined,
  });
  const allToolNames = ctx.pi.getAllTools().map((tool) => tool.name);
  const roleTools = resolveSubAgentTools(agentDef, allToolNames);
  const collaborationTools = [
    "send_message",
    "request_plan_approval",
    "team_task_create",
    "team_task_update",
    "team_task_list",
    "team_task_get",
  ];
  const tools = filterTeammateTools([
    ...new Set([...roleTools, ...collaborationTools]),
  ]);

  const pendingApprovalsMap = new Map<
    string,
    { resolve: (d: PlanApprovalDecision) => void; reject: (e: Error) => void }
  >();
  const pendingApprovals: PendingApprovals = {
    set: (id, entry) => { pendingApprovalsMap.set(id, entry); },
    get: (id) => pendingApprovalsMap.get(id),
    delete: (id) => { pendingApprovalsMap.delete(id); },
  };
  const { session } = await _hydrateSdk.createAgentSessionFromServices({
    services,
    sessionManager: sm,
    tools,
    customTools: [
      buildTeammateSendMessageTool(replayed.identity, {
        mailbox: ctx.handle.mailbox,
        teamStore: ctx.handle.teamStore,
        deliverToLeader: (details, triggerTurn) => {
          postLeaderNotification(ctx.pi, details, triggerTurn);
        },
        persistEvent: (event) => {
          emitTeammateEvent(ctx.pi, event);
        },
      }),
      buildRequestPlanApprovalTool({
        identity: replayed.identity,
        pendingApprovals,
        getLeaderChannel: () => ({
          deliver: (details, triggerTurn) => {
            postLeaderNotification(ctx.pi, details, triggerTurn);
          },
        }),
        onApproved: () => grantApproval(replayed.sessionFile),
      }),
      ...buildTeammateTeamTaskTools(ctx.pi, ctx.handle, replayed.identity),
    ],
  });
  return { session: session as AgentSession, pendingApprovals };
}

/**
 * Re-create running teammates from a previously replayed state.
 *
 * For each teammate whose `lastStatus === "running"`:
 *   1. Open the persisted SessionManager from `sessionFile`.
 *   2. Build services + AgentSession with the same tool blocklist as
 *      `spawnTeammate` (recursion guards + write-class tools — see
 *      teammateToolPool.ts).
 *   3. Register the task in TaskStore with the replayed identity.
 *   4. Ensure the team exists in teamStore and add the agentId as a member.
 *   5. Start `teammateLoop` in resume mode (`initialPrompt: undefined`) so
 *      the loop goes straight to idle waiting on the mailbox. No prompt
 *      boilerplate is prepended on resume — there's no prompt to prepend to.
 *
 * Processes serially (`for ... await`) to avoid races during rebuild.
 * Idempotent: if a running teammate task with the same `agentId` already
 * exists in TaskStore, the entry is skipped.
 */
export async function respawnTeammates(
  state: ReplayedState,
  ctx: RespawnContext,
): Promise<{ respawned: string[]; skipped: string[] }> {
  const respawned: string[] = [];
  const skipped: string[] = [];
  const userDefs = await loadAgentsFromDir(join(homedir(), ".pi", "agents"), "user");
  const projectDefs = await loadAgentsFromDir(join(ctx.cwd, ".pi", "agents"), "project");
  const agentDefs = mergeAgentDefinitions(getBuiltInAgents(), userDefs, projectDefs);
  const capacity = getAgentCapacity(ctx.pi);

  for (const [agentId, replayed] of Object.entries(state.teammates)) {
    if (replayed.lastStatus !== "running") {
      skipped.push(agentId);
      continue;
    }

    // Idempotency: if a running teammate task already exists, skip.
    const exists = Object.values(ctx.taskStore.get()).find(
      (t): t is InProcessTeammateTaskState =>
        isInProcessTeammateTask(t) &&
        t.status === "running" &&
        t.identity.agentId === agentId,
    );
    if (exists) {
      skipped.push(agentId);
      continue;
    }

    // Ensure team exists in teamStore (replay should already include it,
    // but createTeam is a no-op if present, so this is safe).
    const teamState = state.teams[replayed.identity.teamName];
    if (teamState) {
      ctx.handle.teamStore.createTeam(
        teamState.teamName,
        teamState.description,
        teamState.createdAt,
      );
    }

    // Resume must never silently broaden permissions. A deleted role used to
    // fall back to GENERAL_PURPOSE_AGENT (`tools:["*"]`); a changed role could
    // also resume under a different prompt/tool policy. Both now fail closed.
    const agentDef = getAgentDefinition(agentDefs, replayed.identity.agentType);
    const expectedFingerprint = replayed.identity.roleFingerprint;
    const actualFingerprint = agentDef
      ? fingerprintAgentDefinition(agentDef)
      : undefined;
    if (
      !agentDef ||
      (expectedFingerprint !== undefined && expectedFingerprint !== actualFingerprint)
    ) {
      const reason = !agentDef
        ? `Cannot resume ${agentId}: role '${replayed.identity.agentType}' no longer exists`
        : `Cannot resume ${agentId}: role '${replayed.identity.agentType}' changed since spawn`;
      emitTeammateEvent(ctx.pi, {
        kind: "teammate_terminal",
        agentId,
        status: "failed",
      });
      postLeaderNotification(
        ctx.pi,
        { kind: "turn_error", agentId, error: reason },
        /* triggerTurn */ true,
      );
      skipped.push(agentId);
      continue;
    }

    let residentLease: AgentCapacityLease;
    try {
      residentLease = capacity.reserveResident();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      postLeaderNotification(
        ctx.pi,
        { kind: "turn_error", agentId, error: message },
        /* triggerTurn */ true,
      );
      skipped.push(agentId);
      continue;
    }

    ctx.handle.teamStore.addMember(replayed.identity.teamName, agentId);

    // Open the persisted session and wire up an AgentSession on top of it.
    // A failed SDK setup must return the reserved root-session slot.
    let session: AgentSession;
    let pendingApprovals: PendingApprovals;
    try {
      ({ session, pendingApprovals } = await createResumedAgentSession(
        replayed,
        agentDef,
        ctx,
      ));
    } catch (error) {
      residentLease.release();
      ctx.handle.teamStore.removeMember(replayed.identity.teamName, agentId);
      const message = error instanceof Error ? error.message : String(error);
      emitTeammateEvent(ctx.pi, {
        kind: "teammate_terminal",
        agentId,
        status: "failed",
      });
      postLeaderNotification(
        ctx.pi,
        {
          kind: "turn_error",
          agentId,
          error: `Cannot resume ${agentId}: ${message}`,
        },
        /* triggerTurn */ true,
      );
      skipped.push(agentId);
      continue;
    }

    // Register task with the same shape spawnTeammate would create — but
    // start in idle since we are resuming an already-active session.
    const taskId = generateTaskId("in_process_teammate");
    const outputFile = getTaskOutputPath(taskId);
    const initial: InProcessTeammateTaskState = {
      ...createTaskStateBase({
        id: taskId,
        type: "in_process_teammate",
        description: `${replayed.identity.agentName}@${replayed.identity.teamName}`,
        outputFile,
      }),
      type: "in_process_teammate",
      status: "running",
      identity: replayed.identity,
      prompt: replayed.initialPrompt,
      sessionFile: replayed.sessionFile,
      session,
      isIdle: true,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
    registerTask(initial, ctx.taskStore);

    // Init output file (fire-and-forget, EEXIST tolerated for re-respawn races).
    void initTaskOutput(taskId).catch((e: unknown) => {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code: unknown }).code === "EEXIST"
      ) {
        return;
      }
      logError(e, "respawnTeammates initTaskOutput");
    });

    const abortController = new AbortController();
    updateTaskState<InProcessTeammateTaskState>(
      taskId,
      ctx.taskStore,
      (cur) => ({
        ...cur,
        abortController,
        agentResidentLease: residentLease,
      }),
    );

    // Subscribe to session events so the panel widget shows live progress
    // (token / tool / lastTool) on resume too. Without this a reloaded
    // teammate would show "0 tokens / 0 tools" forever even while running.
    // See sessionProgress.ts for the event mapping.
    const unsubscribeSession = subscribeTeammateProgress(
      session,
      taskId,
      ctx.taskStore,
    );

    // Capture refs so closures don't reach back into ctx after the loop returns.
    const teamName = replayed.identity.teamName;
    const piRef = ctx.pi;
    const taskStoreRef = ctx.taskStore;
    const handleRef = ctx.handle;

    registerApprovalSession(replayed.sessionFile, replayed.identity);
    startTeammateLoop({
      identity: replayed.identity,
      initialPrompt: undefined, // resume — go straight to idle
      session,
      mailbox: ctx.handle.mailbox,
      pendingApprovals,
      agentCapacity: capacity,
      approvalSessionId: replayed.sessionFile,
      abortSignal: abortController.signal,
      onTurnStart: () => {
        // Resume turns are also fail-closed until request_plan_approval is
        // explicitly approved by the leader.
        revokeApproval(replayed.sessionFile);
        // Every turn counts on resume too — see spawnTeammate.ts for the
        // rationale (the initial-cause exclusion left turnCount at 0
        // forever for single-cycle teammates).
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({
            ...t,
            isIdle: false,
            lastError: undefined,
            turnCount: t.turnCount + 1,
          }),
        );
      },
      onTurnResult: (text) => {
        if (!text.trim()) return;
        postLeaderNotification(
          piRef,
          { kind: "result", agentId, body: text },
          /* triggerTurn */ true,
        );
      },
      onTurnError: (error) => {
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({ ...t, lastError: error.message }),
        );
        postLeaderNotification(
          piRef,
          { kind: "turn_error", agentId, error: error.message },
          /* triggerTurn */ true,
        );
      },
      onIdle: () => {
        revokeApproval(replayed.sessionFile);
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({ ...t, isIdle: true }),
        );
        // Mirror spawnTeammate.ts — surface idle to the leader's main LLM
        // as an informational notification (triggerTurn:false).
        postLeaderNotification(
          piRef,
          { kind: "idle", agentId },
          /* triggerTurn */ false,
        );
      },
      onMessageAcknowledged: (msg) => {
        emitTeammateEvent(piRef, {
          kind: "message_ack",
          messageId: msg.id,
          agentId,
        });
      },
      onShutdownRequestReceived: (requestId) => {
        emitTeammateEvent(piRef, {
          kind: "shutdown_request",
          agentId,
          requestId,
        });
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({ ...t, shutdownRequested: true }),
        );
      },
      onShutdownAcked: (requestId, approve) => {
        emitTeammateEvent(piRef, {
          kind: "shutdown_response",
          agentId,
          requestId,
          approve,
        });
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({ ...t, shutdownAcknowledged: approve }),
        );
      },
      onTerminal: (reason) => {
        residentLease.release();
        unregisterApprovalSession(replayed.sessionFile);
        // Drop the session-event listener regardless of whether killTeammate
        // already handled the rest of the cleanup. Idempotent.
        unsubscribeSession();

        const cur = taskStoreRef.getTask(taskId) as
          | InProcessTeammateTaskState
          | undefined;
        if (cur?.notified) return;

        const terminalStatus: "completed" | "killed" =
          reason === "shutdown" ? "completed" : "killed";
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({
            ...t,
            status: terminalStatus,
            endTime: Date.now(),
            notified: true,
          }),
        );
        emitTeammateEvent(piRef, {
          kind: "teammate_terminal",
          agentId,
          status: terminalStatus,
        });
        handleRef.teamStore.removeMember(teamName, agentId);
        try {
          session.dispose();
        } catch (e) {
          logError(e, "respawnTeammates session.dispose");
        }
        void evictTaskOutput(taskId);
      },
    });

    respawned.push(agentId);
  }

  // Replay only messages that were persisted but never acknowledged. All
  // running recipients have registered their receiver by this point, so the
  // original per-recipient order can be restored deterministically.
  const pendingMessages = Object.values(state.pendingMessages ?? {}).sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  for (const message of pendingMessages) {
    if (state.teammates[message.to]?.lastStatus !== "running") continue;
    const result = ctx.handle.mailbox.send(message);
    if (!result.ok) {
      logError(new Error(result.error), "respawnTeammates replay message");
    }
  }

  return { respawned, skipped };
}

// ---------- Task A.8: hydrate team_task slice into TeamTaskStore ----------

/**
 * Replay the team_task slice into the in-memory TeamTaskStore.
 *
 * Called from session_start after `hydrateTeammateState`. The reducer has
 * already produced the final state of every team_task surviving create →
 * update → delete; we just have to copy it into the store so subsequent
 * tool calls (team_task_list etc.) see the historical state immediately.
 *
 * Idempotent: tasks already present in the store are skipped, so repeated
 * session_start cycles don't double-insert.
 *
 * Reverse `blocks` invariant: store.createTask re-derives the reverse
 * reference from each new task's `blockedBy` against upstreams already in
 * the store. Object.values() preserves insertion order (= the reducer's
 * processing order, typically createdAt order), so upstreams are usually
 * hydrated before their downstreams and reverse refs accumulate
 * naturally. Edge case: if a downstream is hydrated first, its upstream's
 * `blocks` will be missing that downstream id — known trade-off, see
 * spec §2.5.
 */
export function hydrateTeamTaskStore(
  state: ReplayedState,
  handle: TeammateHandle,
): { hydrated: number; skipped: number } {
  let hydrated = 0;
  let skipped = 0;
  for (const task of Object.values(state.teamTasks)) {
    if (handle.teamTaskStore.getTask(task.id)) {
      skipped++;
      continue;
    }
    const created = handle.teamTaskStore.createTask({
      id: task.id,
      teamName: task.teamName,
      subject: task.subject,
      description: task.description,
      owner: task.owner,
      blockedBy: task.blockedBy,
      metadata: task.metadata,
      createdAt: task.createdAt,
    });
    if (!created) {
      skipped++;
      continue;
    }
    // createTask sets status:"pending" and updatedAt:createdAt — apply
    // overrides via updateTask only when needed.
    if (task.status !== "pending" || task.updatedAt !== task.createdAt) {
      handle.teamTaskStore.updateTask(task.id, {
        status: task.status,
        updatedAt: task.updatedAt,
      });
    }
    hydrated++;
  }
  return { hydrated, skipped };
}
