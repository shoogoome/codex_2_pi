// Reap the background tasks a teammate started.
//
// ## The bug this fixes (measured, not theorized)
//
// Killing a teammate (`k` in the panel, `task_kill`, `team_delete` cascades)
// only tears down the teammate's own AgentSession. Its FOREGROUND bash is
// killed correctly — `session.abort()` → tool signal → `bash.js` onAbort →
// `killProcessTree(pid)`. But a background child it started is NOT:
// `async_bash` spawns `/bin/bash -lc …` whose handle lives only in the
// process-global `pi.async.tasks` registry, outside every AgentSession, so no
// session teardown can reach it.
//
// Observed end-to-end (two teammates, one session):
//   - tfg's foreground `bash sleep 4321`  → after kill: gone      (correct)
//   - tbg's `async_bash sleep 5321`       → after kill: STILL RUNNING
// Both teammate session files stopped growing, proving the teammates
// themselves died and only the child leaked.
//
// The leaked child also stayed `running` in `task_list` and later pushed its
// completion notification to the leader, waking it on behalf of a teammate
// that no longer existed.
//
// ## Why a shared helper rather than logic inside killTeammate
//
// `killTeammate`, `suspendTeammate`, `team_delete` and `hydrate`'s resume
// failure paths all need the same sweep, and the concrete `kill` implementation
// for each task type already exists — it just has to be reached through the
// registry (`getTaskType`) so `tasks` stays independent of `async`/`localshell`
// internals.

import type { TaskStore } from "./taskStore.js";
import { getTaskType } from "./taskTypeRegistry.js";
import { isTerminalTaskStatus, type Task, type TaskStateBase, type TaskType } from "./Task.js";
import { logError } from "./logging.js";

/** Running tasks owned by `agentId` (never includes the teammate's own task). */
export function findOwnedRunningTasks(
  store: TaskStore,
  agentId: string,
): TaskStateBase[] {
  return Object.values(store.get()).filter(
    (t) => t.ownerAgentId === agentId && !isTerminalTaskStatus(t.status),
  );
}

/**
 * Kill every running task owned by `agentId`.
 *
 * Best-effort by design: this runs on terminal paths where a teammate is
 * already going away, so one failing kill (unregistered type, already-dead
 * child, a store that is mid-teardown) must not abort the remaining sweeps nor
 * propagate into the caller's kill sequence.
 *
 * Returns the ids it attempted, for logging/tests.
 *
 * `getImpl` is injectable because the task-type registry is a MODULE-LEVEL Map:
 * the teammate extension runs in its own jiti realm, where importing
 * `getTaskType` directly would read that realm's empty Map and silently find no
 * implementation. Callers in a teammate realm must pass the lookup obtained
 * from the tasks handle (which reaches the real realm through the shared
 * EventBus). Defaults to the local import for same-realm callers/tests.
 */
export async function reapOwnedTasks(
  store: TaskStore,
  agentId: string,
  reason: string,
  getImpl: (type: TaskType) => Task | undefined = getTaskType,
): Promise<string[]> {
  const owned = findOwnedRunningTasks(store, agentId);
  if (owned.length === 0) return [];

  await Promise.all(
    owned.map(async (task) => {
      try {
        const impl = getImpl(task.type);
        if (!impl) {
          // No implementation registered (extension unloaded / never loaded),
          // so nothing can actually stop the process. Report loudly rather
          // than pretend the reap succeeded.
          logError(
            new Error(
              `reapOwnedTasks(${reason}): no kill implementation for task type "${task.type}" (task ${task.id})`,
            ),
            "reapOwnedTasks",
          );
          return;
        }
        await impl.kill(task.id, store);
      } catch (e) {
        logError(e, `reapOwnedTasks(${reason}) task ${task.id}`);
      }
    }),
  );

  return owned.map((t) => t.id);
}
