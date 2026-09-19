// killTeammate — forced kill path (used by task_kill, team_delete cascade,
// session_shutdown).
//
// Sequence (sequence-sensitive, mirrors extensions/localagent/kill.ts):
//   1. Verify task exists + not already terminal — early return otherwise.
//   2. Flip status="killed", set endTime, set notified=true (so the loop's
//      onTerminal callback in spawnTeammate sees notified and skips its own
//      emit/dispose work, avoiding double teammate_terminal events).
//   3. Emit teammate_terminal event (status="killed").
//   4. Remove member from teamStore.
//   5. Reap background tasks the teammate started (see reconcile note below).
//   6. Abort the loop wait and active AgentSession prompt, allowing its
//      execution-capacity lease to settle.
//   7. Dispose the session (defensive/idempotent).
//   8. Evict task output (fire-and-forget).
//
// Step 5 exists because killing the session does NOT reach the teammate's
// background children (measured: an `async_bash sleep 5321` outlived its killed
// owner and later notified the leader). See tasks/reapOwned.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isTerminalTaskStatus,
  type Task,
  type TaskStateBase,
  type TaskStoreLike,
  type TaskType,
} from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import { updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput } from "../tasks/diskOutput.js";
import { logError } from "../tasks/logging.js";
import { reapOwnedTasks } from "../tasks/reapOwned.js";
import { reapChildrenOf } from "../tasks/childReaper.js";
import { getTasksHandle } from "../tasks/handle.js";
import { retireTeammate, type TeammateHandle } from "./handle.js";
import { getTeammateHandle } from "./handle.js";
import { getOwnerIndex } from "../tasks/currentOwner.js";
import { emitTeammateEvent } from "./eventEmit.js";
import type { InProcessTeammateTaskState } from "./types.js";
import { isInProcessTeammateTask } from "./types.js";
import { unregisterApprovalSession } from "./approvalGate.js";

/**
 * Tear down an in-process teammate without writing a terminal event. Used when
 * the leader runtime is replaced/reloaded so the persisted `teammate_spawn`
 * remains resumable on the next session_start.
 *
 * No owned-task sweep here (unlike killTeammate): suspend runs from
 * session_shutdown, where each task extension already tears down its own
 * running tasks (`extensions/async` kills its whole registry, localshell kills
 * its running local_bash tasks). Sweeping here would race those and make a
 * resumable suspension destructive.
 */
export async function suspendTeammate(
  taskStore: TaskStore,
  taskId: string,
): Promise<void> {
  const task = taskStore.getTask(taskId) as InProcessTeammateTaskState | undefined;
  if (!task || isTerminalTaskStatus(task.status)) return;

  updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (cur) => ({
    ...cur,
    status: "killed",
    endTime: Date.now(),
    notified: true,
  }));

  task.agentResidentLease?.release();
  unregisterApprovalSession(task.sessionFile);
  try {
    task.abortController?.abort();
  } catch (e) {
    logError(e, "suspendTeammate abortController");
  }
  try {
    await task.session?.abort();
  } catch (e) {
    logError(e, "suspendTeammate session.abort");
  }
  try {
    task.session?.dispose();
  } catch (e) {
    logError(e, "suspendTeammate session.dispose");
  }
  void evictTaskOutput(taskId);
}

export async function killTeammate(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  handle: TeammateHandle,
  taskId: string,
): Promise<void> {
  const task = taskStore.getTask(taskId) as
    | InProcessTeammateTaskState
    | undefined;
  if (!task || isTerminalTaskStatus(task.status)) return;

  // Step 1+2: flip terminal eagerly + mark notified so the loop's onTerminal
  // callback (in spawnTeammate.ts) sees notified=true and skips its own
  // cleanup path — avoiding double teammate_terminal emit / double dispose.
  updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (cur) => ({
    ...cur,
    status: "killed",
    endTime: Date.now(),
    notified: true,
  }));

  // Step 3: emit terminal event.
  emitTeammateEvent(pi, {
    kind: "teammate_terminal",
    agentId: task.identity.agentId,
    status: "killed",
  });

  // Step 4: remove from team + drop any in-flight approval request so
  // team_plan_approve can no longer answer a teammate that is gone.
  retireTeammate(handle, task.identity, task.sessionFile);
  // Stop attributing new tasks to a teammate that no longer exists.
  getOwnerIndex().unregister(task.sessionFile);

  // Step 5: reap background tasks this teammate started. Must happen BEFORE
  // the session is disposed: the children live outside the session (a
  // process-global registry for async_bash), so nothing in the abort/dispose
  // path can reach them — without this sweep they keep running, stay
  // "running" in task_list, and later push their completion notification to
  // the leader as if their (now dead) owner reported back.
  await reapTeammateOwnedTasks(pi, taskStore, task.identity.agentId, "kill");

  // Release cross-session resources eagerly. The loop's terminal callback is
  // idempotent and may run later after session.abort settles.
  task.agentResidentLease?.release();

  // Step 6: wake any capacity waiter, then abort an active prompt so the
  // loop's finally block can release its execution lease.
  try {
    task.abortController?.abort();
  } catch (e) {
    logError(e, "killTeammate abortController");
  }
  try {
    await task.session?.abort();
  } catch (e) {
    logError(e, "killTeammate session.abort");
  }

  // Step 7: dispose session (the loop sees notified=true and skips its own
  // terminal dispose path).
  try {
    task.session?.dispose();
  } catch (e) {
    logError(e, "killTeammate session.dispose");
  }

  // Step 8: evict output asynchronously.
  void evictTaskOutput(taskId);
}

/**
 * Sweep the background tasks a teammate started.
 *
 * The task-type lookup is taken from the tasks handle rather than this realm's
 * `getTaskType`, because a teammate-realm import would read its own empty
 * registry Map (see reapOwned.ts).
 *
 * Best-effort in two distinct senses:
 *   - No tasks extension loaded → there are no tracked tasks at all, so this is
 *     a legitimate no-op, NOT an error (test harnesses and hosts without the
 *     tasks extension hit this).
 *   - A task whose type has no kill implementation IS reported, by
 *     reapOwnedTasks, because that process really is still running.
 */
async function reapTeammateOwnedTasks(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  agentId: string,
  reason: string,
): Promise<void> {
  let getImpl: ((type: TaskType) => Task | undefined) | undefined;
  try {
    const handle = getTasksHandle(pi);
    getImpl = (type) => handle.getTaskType(type);
  } catch {
    // Tasks extension not loaded in this session. Child reapers below are still
    // worth asking: they live in process-global registries, not in the store.
  }
  // (1) Stop children via the process-global reapers. This is the path that
  //     actually works for a teammate's own background commands, because those
  //     are registered in the TEAMMATE session's TaskStore — a different store
  //     object than the leader-side one swept below (measured: the leader's
  //     store held only the teammate task). See tasks/childReaper.ts.
  let reaped = 0;
  try {
    reaped += await reapChildrenOf(agentId);
  } catch (e) {
    logError(e, "killTeammate reapChildrenOf");
  }
  // (2) Also sweep the leader-side store, for any task that DID land here
  //     (and for task types that do not publish a reaper).
  if (getImpl) {
    try {
      const ids = await reapOwnedTasks(taskStore, agentId, reason, getImpl);
      reaped += ids.length;
    } catch (e) {
      logError(e, "killTeammate reapOwnedTasks");
    }
  }
  if (reaped > 0) {
    console.error(
      `[teammate] reaped ${reaped} background task(s) owned by ${agentId} (${reason})`,
    );
  }
}

// ---- Task interface impl ----
//
// Why a singleton _pi binding instead of dependency injection?
//   The framework's `Task` interface (`kill(taskId, store)`) intentionally
//   does not pass `pi` — it is uniform across task types. LocalShellTask /
//   LocalAgentTask use the same pattern. The entrypoint binds `pi` once in
//   session_start and unbinds it in session_shutdown.

let _currentPi: ExtensionAPI | undefined;

export function _bindPi(pi: ExtensionAPI): void {
  _currentPi = pi;
}

export function _unbindPi(): void {
  _currentPi = undefined;
}

export function _resetTeammatePiBindingForTest(): void {
  _currentPi = undefined;
}

export const InProcessTeammateTask: Task = {
  name: "InProcessTeammateTask",
  type: "in_process_teammate",
  async kill(taskId: string, store: TaskStoreLike): Promise<void> {
    if (!_currentPi) {
      throw new Error(
        "InProcessTeammateTask.kill called before extension session_start (pi not bound)",
      );
    }
    const handle = getTeammateHandle(_currentPi);
    await killTeammate(_currentPi, store as TaskStore, handle, taskId);
  },
  /**
   * Answer "is this teammate wedged, or just busy?" — the question that could
   * not be answered before, and which got a 200s `sleep`-polling artist
   * misdiagnosed as unresponsive and killed.
   *
   * `lastTool` + `lastToolStartedAt` is the load-bearing pair: a teammate
   * that has been inside `bash` for 3 minutes is NOT hung, it simply cannot
   * read messages until that call returns. Treating message latency as a
   * liveness signal is the mistake this block exists to prevent.
   */
  describe(taskId: string, store: TaskStoreLike): string[] | undefined {
    const task = store.getTask(taskId) as InProcessTeammateTaskState | undefined;
    if (!task || !isInProcessTeammateTask(task)) return undefined;
    const lines: string[] = [];
    const who = task.identity?.agentId ?? taskId;
    lines.push(`teammate: ${who}`);
    lines.push(
      task.isIdle
        ? "state: idle (between turns — NOT necessarily finished, stuck, or waiting on you)"
        : "state: running (currently inside a turn)",
    );
    if (task.lastTool) {
      const since = task.lastToolStartedAt ? Date.now() - task.lastToolStartedAt : undefined;
      const held = since !== undefined ? ` for ${formatDuration(since)}` : "";
      lines.push(`current tool: ${task.lastTool}${held}`);
      // The single most useful sentence in this block: distinguish "taking a
      // long time inside a tool call" from "wedged".
      if (!task.isIdle && since !== undefined && since > 60_000) {
        lines.push(
          `  ⚠ inside ${task.lastTool} for >1min — it CANNOT read your messages until this returns; this is normal for a long poll, not a hang`,
        );
      }
    }
    if (task.pendingMessages.length > 0) {
      lines.push(
        `queued messages: ${task.pendingMessages.length} (delivered when the current turn ends)`,
      );
    }
    lines.push(`turns: ${task.turnCount} · tool calls: ${task.toolCallCount}`);
    if (task.shutdownRequested) {
      lines.push(
        task.shutdownAcknowledged
          ? "shutdown: requested and acknowledged (should exit shortly)"
          : "shutdown: requested, NOT yet acknowledged (it never saw the request — consider task_kill)",
      );
    }
    if (task.lastError) lines.push(`last error: ${task.lastError}`);
    return lines;
  },
};

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}
