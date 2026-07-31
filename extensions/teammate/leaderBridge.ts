// leaderBridge — fallback process-global channel for code paths that cannot
// capture the leader delivery closure directly. Fresh and hydrated in-process
// teammates use an identity-bound direct closure.
//
// Why this exists (see spikes recorded in the D2 plan / spec):
//   A teammate runs inside its OWN AgentSession, created via
//   `createAgentSessionServices` WITHOUT sharing the leader's eventBus. That
//   means the teammate sub-session loads its OWN copy of this extension with
//   its OWN TeammateHandle (mailbox / teamStore) attached on its OWN eventBus.
//   So a teammate calling `send_message {to:"leader"}` / postLeaderNotification
//   against the sub-session's `pi` can NEVER reach the real leader: the
//   message lands in the sub-session's mailbox / the teammate's own jsonl.
//
//   handle.ts attaches state on `pi.events` (the eventBus) precisely because
//   "Pi loads each extension under its own jiti module realm, so extensions
//   can't share singletons via simple module-level exports". The eventBus
//   trick works WITHIN a session but NOT across the leader/teammate session
//   boundary (different eventBus instances — spike-proven).
//
//   This module bridges that boundary using a `globalThis` symbol registry,
//   which IS shared across module realms / sessions in the same process
//   (spike-proven). The leader registers a delivery callback in session_start;
//   teammate-side tools look it up via getLeaderChannel() and deliver.
//
// What the channel stores:
//   The `deliver` callback closes over the LEADER session's notification
//   injector. Spike-proven facts that shape this:
//     - The ONLY thing that marks the leader extension runtime "stale" is the
//       leader's own AgentSession.dispose() (newSession/fork/reload). A
//       teammate sub-session being active does NOT make the leader stale.
//     - So the leader's notification injector stays valid for the whole
//       lifetime of the leader session; we unregister in session_shutdown.

import type { LeaderNotificationDetails } from "./types.js";

/** A leader-side delivery channel. `deliver` injects a notification into the
 * leader's main LLM session (DM => triggerTurn:true wakes the leader). */
export interface LeaderChannel {
  deliver(details: LeaderNotificationDetails, triggerTurn: boolean): void;
}

interface LeaderBridgeRegistry {
  /** sessionId -> channel, insertion-ordered (Map preserves order). */
  channels: Map<string, LeaderChannel>;
}

const BRIDGE_KEY = Symbol.for("pi.teammate.leaderBridge");

function getRegistry(): LeaderBridgeRegistry {
  const g = globalThis as unknown as Record<symbol, LeaderBridgeRegistry | undefined>;
  let reg = g[BRIDGE_KEY];
  if (!reg) {
    reg = { channels: new Map<string, LeaderChannel>() };
    g[BRIDGE_KEY] = reg;
  }
  return reg;
}

/**
 * Register (or replace) the leader channel for a given session id. Re-inserts
 * so the channel becomes the most-recent (getLeaderChannel prefers latest).
 */
export function registerLeaderChannel(sessionId: string, channel: LeaderChannel): void {
  const { channels } = getRegistry();
  // Delete first so re-insertion moves it to the end (most-recent) on replace.
  channels.delete(sessionId);
  channels.set(sessionId, channel);
}

/** Remove a leader channel. No-op if the session id is unknown. */
export function unregisterLeaderChannel(sessionId: string): void {
  getRegistry().channels.delete(sessionId);
}

/**
 * Resolve the active leader channel. Returns the most-recently-registered
 * channel (in practice there is exactly one leader per process; teammate
 * sub-sessions never register because their session_start handler does not
 * run — they are driven via prompt() not bindExtensions()).
 */
export function getLeaderChannel(): LeaderChannel | undefined {
  const { channels } = getRegistry();
  let latest: LeaderChannel | undefined;
  for (const ch of channels.values()) latest = ch;
  return latest;
}

/** Test-only: clear the global registry. */
export function _resetLeaderBridgeForTest(): void {
  getRegistry().channels.clear();
}
