import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ULTRA_STATE_ENTRY,
  ULTRA_STATUS_KEY,
  appendUltraModePrompt,
  isUltraCapableModel,
  restoreUltraStateFromBranch,
} from "./ultra.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const NATIVE_ULTRA_LEVEL = "max";

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

export default function effortExtension(pi: ExtensionAPI): void {
  let ultraEnabled = false;

  function isNativeMax(): boolean {
    return String(pi.getThinkingLevel()) === NATIVE_ULTRA_LEVEL;
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(ULTRA_STATUS_KEY, ultraEnabled ? "effort:ultra" : undefined);
  }

  function setUltraEnabled(enabled: boolean, ctx: ExtensionContext, persist: boolean): void {
    ultraEnabled = enabled;
    if (persist) pi.appendEntry(ULTRA_STATE_ENTRY, { enabled });
    updateStatus(ctx);
  }

  function restore(ctx: ExtensionContext): void {
    const restored = restoreUltraStateFromBranch(ctx.sessionManager.getBranch());
    ultraEnabled = restored?.enabled === true
      && isUltraCapableModel(ctx.model)
      && isNativeMax();
    updateStatus(ctx);
  }

  pi.registerCommand("effort", {
    description: `Set thinking effort level: ${LEVELS.join("|")} (ultra = max + proactive delegation)`,
    getArgumentCompletions: (prefix: string) => {
      const items = LEVELS.map((level) => ({ value: level, label: level }));
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const level = args.trim().toLowerCase();
      if (!level) {
        const current = ultraEnabled ? "ultra (native: max; proactive delegation)" : pi.getThinkingLevel();
        ctx.ui.notify(`Current effort: ${current} (options: ${LEVELS.join(", ")})`, "info");
        return;
      }
      if (!(LEVELS as readonly string[]).includes(level)) {
        ctx.ui.notify(`Unknown effort level "${level}". Options: ${LEVELS.join(", ")}`, "warning");
        return;
      }

      if (level === "ultra") {
        const currentModel = ctx.model;
        if (!currentModel || !isUltraCapableModel(currentModel)) {
          ctx.ui.notify(
            `Ultra is available for gpt-5.6-sol and gpt-5.6-terra; current model is ${currentModel?.id ?? "unknown"}.`,
            "warning",
          );
          return;
        }

        const previousLevel = pi.getThinkingLevel();
        pi.setThinkingLevel(NATIVE_ULTRA_LEVEL as ThinkingLevel);
        if (!isNativeMax()) {
          pi.setThinkingLevel(previousLevel);
          ctx.ui.notify(
            `Current ${currentModel.provider}/${currentModel.id} configuration does not expose native max effort; Ultra was not enabled.`,
            "warning",
          );
          return;
        }

        setUltraEnabled(true, ctx, true);
        const hasAgentTool = pi.getActiveTools().includes("task_agent");
        ctx.ui.notify(
          hasAgentTool
            ? "Effort set to ultra (native: max; proactive task delegation enabled)."
            : "Effort set to ultra (native: max), but task_agent is not active; proactive delegation has no agent tool.",
          hasAgentTool ? "info" : "warning",
        );
        return;
      }

      if (ultraEnabled) setUltraEnabled(false, ctx, true);
      pi.setThinkingLevel(level as ThinkingLevel);
      ctx.ui.notify(`Effort set to ${level} (effective: ${pi.getThinkingLevel()})`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (
      !ultraEnabled
      || !isUltraCapableModel(ctx.model)
      || !isNativeMax()
    ) {
      return;
    }
    return { systemPrompt: appendUltraModePrompt(event.systemPrompt) };
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (ultraEnabled && String(event.level) !== NATIVE_ULTRA_LEVEL) {
      setUltraEnabled(false, ctx, true);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (
      ultraEnabled
      && (!isUltraCapableModel(event.model) || !isNativeMax())
    ) {
      setUltraEnabled(false, ctx, true);
    }
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (_event, ctx) => restore(ctx));
}
