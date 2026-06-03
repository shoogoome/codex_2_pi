// AsyncLocalStorage wrapper for teammate identity isolation.
//
// Spike-validated (extensions/spike-als-teammate, deleted): ALS context survives
// across session.subscribe callbacks and session.prompt() awaits. This is the
// foundation for in-process teammates — every long-lived AgentSession runs its
// listeners and prompt() inside `runAsTeammate(identity, ...)`, so any helper
// (notably the SendMessage tool) can resolve the current sender via getCurrentTeammate.

import { AsyncLocalStorage } from "node:async_hooks";
import type { TeammateIdentity } from "./types.js";

const storage = new AsyncLocalStorage<TeammateIdentity>();

/**
 * Run `fn` with the given teammate identity bound on AsyncLocalStorage.
 * Returns the function's return value (or rejects on throw).
 */
export function runAsTeammate<T>(identity: TeammateIdentity, fn: () => T): T {
  return storage.run(identity, fn);
}

/**
 * Returns the current teammate identity, or undefined when called outside
 * any runAsTeammate scope (e.g., from leader/main LLM context).
 */
export function getCurrentTeammate(): TeammateIdentity | undefined {
  return storage.getStore();
}

/**
 * Test-only no-op. ALS doesn't expose a clear API; tests should scope context
 * via runAsTeammate rather than rely on global resets. Kept for symmetry with
 * other test resets in the codebase.
 */
export function _resetForTest(): void {
  // Intentionally empty.
}
