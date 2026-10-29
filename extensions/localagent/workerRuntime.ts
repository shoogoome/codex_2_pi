import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyFastServiceTier } from "../fast-mode/core.js";
import type { FastModeReader } from "../fast-mode/handle.js";
import { attachWorkerBridge, type WorkerBridge } from "../coordinator/handle.js";
import { applyCoordinatorPolicy } from "../shared/agentWorkflowPolicy.js";
import { getAgentMutationPause } from "../shared/agentMutationPause.js";
import { isWriteTool, isWriteBashCommand } from "../plan-mode/src/guard.js";

export const FORK_FORBIDDEN_TOOLS = new Set(["task_agent", "team_create"]);

/** Worker-only hooks; deliberately does not initialize leader lifecycle handlers. */
export function buildWorkerRuntime(readFast: FastModeReader, isOpen: () => boolean = () => true, coordination?: WorkerBridge): (pi: ExtensionAPI) => void {
  return (pi) => {
    if (coordination) attachWorkerBridge(pi, coordination);
    pi.on("before_agent_start", event => ({ systemPrompt: applyCoordinatorPolicy(event.systemPrompt, { worker: true, enabled: false, effective: "off" }) }));
    // Inline factories load after configured extensions. This final input gate
    // rechecks cancellation after earlier asynchronous input transformations.
    pi.on("input", () => isOpen() ? undefined : { action: "handled" });
    pi.on("before_provider_request", (event, ctx) => {
      // Payload hooks are not cancellation gates: Pi reports hook errors and continues.
      const state = readFast();
      const model = ctx.model;
      let usingOAuth = false;
      try {
        usingOAuth = Boolean(model && ctx.modelRegistry.isUsingOAuth(model));
      } catch {
        // Never request a paid/unsupported routing tier on unknown auth.
      }
      const payload = applyFastServiceTier(event.payload, { ...state, model, usingOAuth });
      return payload === event.payload ? undefined : payload;
    });
    // Also applies to nested/codemode calls: hiding a declaration alone is not
    // the leaf-worker boundary. task_agent includes BOTH fork and teammate mode.
    pi.on("tool_call", (event) => {
      if (!isOpen()) return { block: true, reason: "LocalAgent input is closed" };
      if (getAgentMutationPause().paused) {
        const command = (event.input as { command?: unknown }).command;
        const shell = ["bash", "task_bash", "async_bash"].includes(event.toolName);
        if (isWriteTool(event.toolName) || event.toolName.startsWith("mcp__") || (shell && (typeof command !== "string" || isWriteBashCommand(command)))) {
          return { block: true, reason: "Root Plan mode is read-only; this existing worker must not mutate state." };
        }
      }
      if (FORK_FORBIDDEN_TOOLS.has(event.toolName)) {
        return { block: true, reason: "LocalAgent is a leaf worker: spawning agents or teams is disabled." };
      }
    });
  };
}


/** Stop late async input from issuing a model request after task disposal. */
export function guardWorkerStream(
  session: Pick<import("@earendil-works/pi-coding-agent").AgentSession, "agent">,
  isOpen: () => boolean,
): void {
  const agent = session.agent;
  if (!agent || typeof agent.streamFunction !== "function") return;
  const stream = agent.streamFunction;
  agent.streamFunction = (...args) => {
    if (!isOpen()) throw new Error("LocalAgent task is closed");
    return stream(...args);
  };
}
