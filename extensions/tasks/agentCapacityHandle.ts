// Cross-extension AgentCapacity handle.
//
// Pi loads extension packages in isolated module realms, while pi.events is
// shared by every extension in the current root session. Store the controller
// there so localagent and teammate enforce one combined budget.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentCapacity,
  type AgentCapacity,
  type AgentCapacityOptions,
} from "./agentCapacity.js";

const HANDLE_KEY = "__pi_agent_capacity__";

export function attachAgentCapacity(pi: ExtensionAPI, capacity: AgentCapacity): void {
  (pi.events as unknown as Record<string, AgentCapacity>)[HANDLE_KEY] = capacity;
}

export function getAgentCapacity(
  pi: ExtensionAPI,
  options?: AgentCapacityOptions,
): AgentCapacity {
  const events = pi.events as unknown as Record<string, AgentCapacity | undefined>;
  // Lazy fallback keeps direct unit-test harnesses and selectively installed
  // extensions safe; production attaches the canonical controller from tasks.
  if (!events[HANDLE_KEY]) events[HANDLE_KEY] = createAgentCapacity(options);
  return events[HANDLE_KEY];
}
