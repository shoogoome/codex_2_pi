// Process-global registry of "kill the child processes owned by teammate X".
//
// ## Why store traversal is not enough (measured)
//
// `reapOwnedTasks` sweeps the TaskStore for `ownerAgentId === X`. That works
// only if the task is in the SAME store the reaper reads — and it is not.
//
// A teammate runs as its own session, and pi loads the `tasks` extension once
// per session realm. So when a teammate calls `async_bash`, the task is
// registered into the TEAMMATE session's TaskStore, not the leader's. Measured
// on a real teammate:
//
//   [async:DIAG] POST-REGISTER tag=store-76c9dr keys=["bq35gzimt"] sameDefaultStore=true
//   [killTeammate:DIAG] storeTasks=[{id:"tvky7je02",type:"in_process_teammate"}, ...]
//   [killTeammate:DIAG] sameStore=true killTag=<none>     <-- different store object
//   [killTeammate:DIAG] reapOwnedTasks -> []              <-- so it finds nothing
//
// The teammate's own task IS in the leader's store (spawnTeammate registers it
// there), which is why `task_list` in the leader showed the teammate but never
// its background command — a second, user-visible symptom of the same split.
//
// ## What this module does
//
// Each task-hosting extension keeps its own process-global bookkeeping of the
// children it spawned (that is where the ChildProcess handles live anyway, and
// `globalThis` + `Symbol.for` is shared across realms). Those extensions
// register a reaper here; the teammate kill path asks every reaper to stop the
// children belonging to a given agent. No store identity is involved, so the
// realm split is irrelevant.

/** Stop the children owned by `agentId`; returns how many it attempted. */
export type ChildReaper = (agentId: string) => Promise<number>;

const REAPERS_KEY = Symbol.for("pi.tasks.childReapers");

interface ReaperSlot {
  reapers?: Map<string, ChildReaper>;
}

function slot(): ReaperSlot {
  const target = globalThis as unknown as Record<symbol, ReaperSlot | undefined>;
  let value = target[REAPERS_KEY];
  if (!value) {
    value = {};
    target[REAPERS_KEY] = value;
  }
  if (!value.reapers) value.reapers = new Map();
  return value;
}

/**
 * Publish a reaper. `key` identifies the owning extension ("async",
 * "localshell", …) so re-registration after a session reload replaces rather
 * than accumulates.
 */
export function registerChildReaper(key: string, reaper: ChildReaper): void {
  slot().reapers!.set(key, reaper);
}

export function unregisterChildReaper(key: string): void {
  slot().reapers?.delete(key);
}

/**
 * Ask every registered reaper to stop `agentId`'s children.
 *
 * Best-effort: this runs on a terminal path where the teammate is already going
 * away, so one failing reaper must not prevent the others — nor turn a kill into
 * a failure. Returns the total attempted.
 */
export async function reapChildrenOf(agentId: string): Promise<number> {
  const reapers = slot().reapers;
  if (!reapers || reapers.size === 0) return 0;
  const results = await Promise.all(
    [...reapers.values()].map(async (reaper) => {
      try {
        return await reaper(agentId);
      } catch {
        return 0;
      }
    }),
  );
  return results.reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

/** Test-only. */
export function _resetChildReapersForTest(): void {
  slot().reapers?.clear();
}
