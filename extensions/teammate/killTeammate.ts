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
//   5. Try session.dispose() (defensive — onTerminal also tries; idempotent).
//   6. Call abortController.abort() — wakes the loop, which calls onTerminal
//      but sees notified=true and skips re-doing.
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
import type { TeammateHandle } from "./handle.js";
import { getTeammateHandle } from "./handle.js";
import { emitTeammateEvent } from "./eventEmit.js";
import type { InProcessTeammateTaskState } from "./types.js";

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

  // Step 4: remove from team.
  handle.teamStore.removeMember(task.identity.teamName, task.identity.agentId);

  // Step 5: dispose session (defensive — loop's onTerminal would also dispose
  // if not notified, but we already flipped notified so it's our job now).
  try {
    task.session?.dispose();
  } catch (e) {
    logError(e, "killTeammate session.dispose");
  }

  // Step 6: wake the loop so it exits cleanly. The loop sees abortSignal
  // fired, runs its onTerminal callback, finds notified=true, and skips.
  try {
    task.abortController?.abort();
  } catch (e) {
    logError(e, "killTeammate abort");
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
};
