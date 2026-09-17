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
//   5. Abort the loop wait and active AgentSession prompt, allowing its
//      execution-capacity lease to settle.
//   6. Dispose the session (defensive/idempotent).
//   7. Evict task output (fire-and-forget).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isTerminalTaskStatus,
  type Task,
  type TaskStoreLike,
} from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import { updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput } from "../tasks/diskOutput.js";
import { logError } from "../tasks/logging.js";
import { retireTeammate, type TeammateHandle } from "./handle.js";
import { getTeammateHandle } from "./handle.js";
import { emitTeammateEvent } from "./eventEmit.js";
import type { InProcessTeammateTaskState } from "./types.js";
import { isInProcessTeammateTask } from "./types.js";
import { unregisterApprovalSession } from "./approvalGate.js";

/**
 * Tear down an in-process teammate without writing a terminal event. Used when
 * the leader runtime is replaced/reloaded so the persisted `teammate_spawn`
 * remains resumable on the next session_start.
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

  // Release cross-session resources eagerly. The loop's terminal callback is
  // idempotent and may run later after session.abort settles.
  task.agentResidentLease?.release();

  // Step 5: wake any capacity waiter, then abort an active prompt so the
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

  // Step 6: dispose session (the loop sees notified=true and skips its own
  // terminal dispose path).
  try {
    task.session?.dispose();
  } catch (e) {
    logError(e, "killTeammate session.dispose");
  }

  // Step 7: evict output asynchronously.
  void evictTaskOutput(taskId);
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
