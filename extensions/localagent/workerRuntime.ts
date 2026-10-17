import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyFastServiceTier } from "../fast-mode/core.js";
import type { FastModeReader } from "../fast-mode/handle.js";

export const FORK_FORBIDDEN_TOOLS = new Set(["task_agent", "team_create"]);

/** Worker-only hooks; deliberately does not initialize leader lifecycle handlers. */
export function buildWorkerRuntime(readFast: FastModeReader): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
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
      if (FORK_FORBIDDEN_TOOLS.has(event.toolName)) {
        return { block: true, reason: "LocalAgent is a leaf worker: spawning agents or teams is disabled." };
      }
    });
  };
}
