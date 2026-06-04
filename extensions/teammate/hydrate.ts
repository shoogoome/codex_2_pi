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

import {
  createAgentSessionServices as _realCreateAgentSessionServices,
  createAgentSessionFromServices as _realCreateAgentSessionFromServices,
  SessionManager as _RealSessionManager,
  type AgentSession,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import type { TaskStore } from "../tasks/taskStore.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput, initTaskOutput } from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { createTaskStateBase, generateTaskId } from "../tasks/Task.js";
import { logError } from "../tasks/logging.js";

import { TEAMMATE_EVENT_CUSTOM_TYPE, emitTeammateEvent } from "./eventEmit.js";
import { postLeaderNotification } from "./leaderNotification.js";
import {
  reduceTeammateEvents,
  type ReplayedState,
} from "./jsonlEvents.js";
import type { TeammateHandle } from "./handle.js";
import { startTeammateLoop } from "./teammateLoop.js";
import { filterTeammateTools } from "./teammateToolPool.js";
import { subscribeTeammateProgress } from "./sessionProgress.js";
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
  createAgentSessionServices: (opts: { cwd: string }) => Promise<unknown>;
  SessionManagerOpen: (path: string) => unknown;
  createAgentSessionFromServices: (opts: {
    services: unknown;
    sessionManager: unknown;
    tools: readonly string[];
  }) => Promise<{ session: unknown }>;
}

const _hydrateSdkDefaults: HydrateSdkBindings = {
  createAgentSessionServices: (opts) =>
    _realCreateAgentSessionServices({ cwd: opts.cwd }) as unknown as Promise<unknown>,
  SessionManagerOpen: (path) => _RealSessionManager.open(path),
  createAgentSessionFromServices: (opts) =>
    _realCreateAgentSessionFromServices({
      services: opts.services as never,
      sessionManager: opts.sessionManager as never,
      tools: opts.tools as never,
    }) as unknown as Promise<{ session: unknown }>,
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
    ctx.handle.teamStore.addMember(replayed.identity.teamName, agentId);

    // Open the persisted session and wire up an AgentSession on top of it.
    const sm = _hydrateSdk.SessionManagerOpen(replayed.sessionFile);
    const services = await _hydrateSdk.createAgentSessionServices({ cwd: ctx.cwd });
    // Use getAllTools (registered tools, not just currently-active set) so
    // the teammate gets bash even when the leader's localshell extension
    // hides it. See spawnTeammate.ts for the full rationale.
    const allToolInfos = ctx.pi.getAllTools();
    const allToolNames = allToolInfos.map((t) => t.name);
    const tools = filterTeammateTools(allToolNames);
    const { session: sessionUnknown } =
      await _hydrateSdk.createAgentSessionFromServices({
        services,
        sessionManager: sm,
        tools,
      });
    const session = sessionUnknown as AgentSession;

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

    startTeammateLoop({
      identity: replayed.identity,
      initialPrompt: undefined, // resume — go straight to idle
      session,
      mailbox: ctx.handle.mailbox,
      abortSignal: abortController.signal,
      onTurnStart: () => {
        // Every turn counts on resume too — see spawnTeammate.ts for the
        // rationale (the initial-cause exclusion left turnCount at 0
        // forever for single-cycle teammates).
        updateTaskState<InProcessTeammateTaskState>(
          taskId,
          taskStoreRef,
          (t) => ({
            ...t,
            isIdle: false,
            turnCount: t.turnCount + 1,
          }),
        );
      },
      onIdle: () => {
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
