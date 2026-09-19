// Cross-realm task-ownership registry.
//
// ## The problem
//
// A teammate's background children must be reaped when the teammate is killed.
// `async_bash` / auto-backgrounded `task_bash` keep their ChildProcess in a
// process-global registry OUTSIDE any AgentSession, so `session.abort()` +
// `dispose()` cannot reach them. Measured: after killing a teammate, its
// `async_bash sleep 5321` was still running, still listed `running` in
// `task_list`, and later pushed a completion notification to the leader.
//
// To reap them, each task needs to record WHO started it.
//
// ## Why AsyncLocalStorage is the wrong mechanism here (already burned once)
//
// The teammate's identity is not reachable from a task-starting tool call.
// `teammateLoop` calls `runAsTeammate()` — but that roots the LEADER realm's
// AsyncLocalStorage instance, while `async_bash` executes in the tool-call
// realm of the teammate's OWN sub-session (a separate jiti module realm with
// its own copy of the ALS object). So `getCurrentTeammate()` inside the tool
// returns undefined. `extensions/teammate/tools/teammateSendMessage.ts`
// documents this exact trap for `send_message`; the fix there was to stop
// relying on ALS and bind identity at spawn time.
//
// Verified empirically with temporary diagnostics on a real teammate:
//   [currentOwner:DIAG] probes=3
//   [teammate:DIAG] owner probe called -> <no teammate ctx>   // ALS empty
//   [async:DIAG] spawnAsyncShell owner=<none>                // so no owner tag
//
// ## What this module does instead
//
// The teammate extension registers a map from the teammate's own persisted
// session file → agentId at spawn/resume time (it knows both). A task-starting
// tool call reads its session file from `ctx.sessionManager.getSessionFile()`,
// which is realm-safe data (not async context) and exactly identifies the
// calling session: the leader's file maps to nothing → no owner, a teammate's
// file maps to its agentId. No async-context propagation is involved, so the
// realm boundary is irrelevant.

/** Maps a persisted session file → the teammate that owns it. */
export interface OwnerIndex {
  register(sessionFile: string, agentId: string): void;
  unregister(sessionFile: string | undefined): void;
  lookup(sessionFile: string | undefined): string | undefined;
  /** Number of attributed sessions; for diagnostics only. */
  size(): number;
}

const INDEX_KEY = Symbol.for("pi.tasks.ownerIndex");

interface IndexSlot {
  index?: OwnerIndex;
}

function slot(): IndexSlot {
  const target = globalThis as unknown as Record<symbol, IndexSlot | undefined>;
  let value = target[INDEX_KEY];
  if (!value) {
    value = {};
    target[INDEX_KEY] = value;
  }
  return value;
}

/**
 * Create (or return) the process-global owner index.
 *
 * `globalThis` + `Symbol.for` because the teammate extension and the
 * task-starting extensions live in different jiti realms; a module-level Map
 * would be written in one realm and read as empty from another (the mistake
 * that once silently disabled the approval gate).
 */
export function getOwnerIndex(): OwnerIndex {
  const current = slot().index;
  if (current) return current;
  const bySessionFile = new Map<string, string>();
  const created: OwnerIndex = {
    register(sessionFile, agentId) {
      if (sessionFile) bySessionFile.set(sessionFile, agentId);
    },
    unregister(sessionFile) {
      if (sessionFile) bySessionFile.delete(sessionFile);
    },
    lookup(sessionFile) {
      return sessionFile ? bySessionFile.get(sessionFile) : undefined;
    },
    size() {
      return bySessionFile.size;
    },
  };
  slot().index = created;
  return created;
}

/** Reaper-side helper: which teammate owns the current tool call, if any. */
export function ownerFromSessionFile(sessionFile: string | undefined): string | undefined {
  return slot().index?.lookup(sessionFile);
}

/** Diagnostic: how many sessions are currently attributed to a teammate. */
export function ownerIndexSize(): number {
  return slot().index?.size() ?? 0;
}

/** Test-only: drop the whole index. */
export function _resetOwnerIndexForTest(): void {
  slot().index = undefined;
}

// ---------------------------------------------------------------------------
// Owner liveness
// ---------------------------------------------------------------------------
//
// A task that finishes AFTER its owning teammate is gone must not push its
// completion notification to the leader: the leader would be woken by, and told
// about, a teammate that no longer exists. Reaping removes the main source;
// this guard covers a reap that could not stop the child.

/** True when `agentId` is still an active member of a live team. */
export type OwnerLivenessProbe = (agentId: string) => boolean;

const LIVENESS_KEY = Symbol.for("pi.tasks.ownerLivenessProbe");

interface LivenessSlot {
  /**
   * One probe per live extension realm. A Set rather than a single slot: the
   * teammate extension is loaded once per session realm, so a teammate
   * sub-session's copy would otherwise overwrite the leader realm's probe.
   */
  probes?: Set<OwnerLivenessProbe>;
}

function livenessSlot(): LivenessSlot {
  const target = globalThis as unknown as Record<symbol, LivenessSlot | undefined>;
  let value = target[LIVENESS_KEY];
  if (!value) {
    value = { probes: new Set() };
    target[LIVENESS_KEY] = value;
  } else if (!value.probes) {
    value.probes = new Set();
  }
  return value;
}

export function setOwnerLivenessProbe(probe: OwnerLivenessProbe | undefined): void {
  const s = livenessSlot();
  if (!s.probes) s.probes = new Set();
  if (probe === undefined) {
    s.probes.clear();
    return;
  }
  s.probes.add(probe);
}

/**
 * Should a terminal notification for `ownerAgentId` be delivered at all?
 *
 * Leader-owned tasks (no owner) always deliver. Fail-open in every uncertain
 * case — no team extension, a probe error, or a split across realms — because
 * swallowing a legitimate notification is worse than an extra one. Only a
 * definite "every registered probe agrees this agent is gone" filters.
 */
export function isOwnerActive(ownerAgentId: string | undefined): boolean {
  if (ownerAgentId === undefined) return true;
  const probes = livenessSlot().probes;
  if (!probes || probes.size === 0) return true;
  let sawAnswer = false;
  for (const probe of probes) {
    try {
      if (probe(ownerAgentId)) return true;
      sawAnswer = true;
    } catch {
      return true; // indeterminate → fail open
    }
  }
  return sawAnswer ? false : true;
}

/** Test-only. */
export function _resetOwnerLivenessProbeForTest(): void {
  livenessSlot().probes?.clear();
}
