// Cross-extension AgentCapacity handle.
//
// Pi loads extension packages in isolated module realms. Pi 0.84+ also gives
// each extension its own `pi.events` facade, so the capacity controller is
// published through attachSessionHandle (shared EventBus + direct property).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachSessionHandle, getSessionHandle } from "../shared/sessionHandle.js";
import {
  createAgentCapacity,
  type AgentCapacity,
  type AgentCapacityOptions,
} from "./agentCapacity.js";

const HANDLE_KEY = "__pi_agent_capacity__";

export function attachAgentCapacity(pi: ExtensionAPI, capacity: AgentCapacity): void {
  attachSessionHandle(pi, HANDLE_KEY, capacity);
}

export function getAgentCapacity(
  pi: ExtensionAPI,
  options?: AgentCapacityOptions,
): AgentCapacity {
  const existing = getSessionHandle<AgentCapacity>(pi, HANDLE_KEY);
  if (existing) return existing;
  // Lazy fallback keeps direct unit-test harnesses and selectively installed
  // extensions safe; production attaches the canonical controller from tasks.
  const created = createAgentCapacity(options);
  attachSessionHandle(pi, HANDLE_KEY, created);
  return created;
}
