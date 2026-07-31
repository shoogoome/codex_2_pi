import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type NativeThinkingLevel,
  ULTRA_IGNITION_WIDGET_KEY,
  ULTRA_STATE_ENTRY,
  ULTRA_STATUS_KEY,
  isNativeThinkingLevel,
  isUltraCapableModel,
  restoreUltraStateFromBranch,
  upsertMultiAgentModePrompt,
} from "./core.js";
import {
  attachUltraHandle,
  type UltraEnableOptions,
  type UltraHandle,
} from "./handle.js";

const NATIVE_ULTRA_LEVEL = "max";
type PiThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

/**
 * Codex Ultra controller.
 *
 * Ultra is selected through extensions/effort, but its state machine is kept
 * here because it spans request normalization, multi-agent policy, session
 * restore, model changes, and persistent TUI state.
 */
export default function ultraExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let fallbackLevel: NativeThinkingLevel | undefined;
  let ignitionTimer: ReturnType<typeof setTimeout> | undefined;

  function currentNativeLevel(): NativeThinkingLevel | undefined {
    const level = String(pi.getThinkingLevel());
    return isNativeThinkingLevel(level) ? level : undefined;
  }

  function isNativeMax(): boolean {
    return currentNativeLevel() === NATIVE_ULTRA_LEVEL;
  }

  function styledStatus(ctx: ExtensionContext): string {
    try {
      return ctx.ui.theme.bold(ctx.ui.theme.fg("accent", "» ULTRA · multi-agent"));
    } catch {
      return "» ULTRA · multi-agent";
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(ULTRA_STATUS_KEY, enabled ? styledStatus(ctx) : undefined);
  }

  function clearIgnition(ctx: ExtensionContext): void {
    if (ignitionTimer) {
      clearTimeout(ignitionTimer);
      ignitionTimer = undefined;
    }
    if (ctx.hasUI) ctx.ui.setWidget(ULTRA_IGNITION_WIDGET_KEY, undefined);
  }

  function flashIgnition(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    clearIgnition(ctx);
    let headline = "» ULTRA";
    let detail = "Maximum reasoning · proactive multi-agent delegation";
    try {
      headline = ctx.ui.theme.bold(ctx.ui.theme.fg("accent", headline));
      detail = ctx.ui.theme.fg("dim", detail);
    } catch {
      // Plain text remains usable in lightweight/nonstandard UI hosts.
    }
    ctx.ui.setWidget(ULTRA_IGNITION_WIDGET_KEY, [headline, detail], { placement: "aboveEditor" });
    ignitionTimer = setTimeout(() => {
      ignitionTimer = undefined;
      try {
        ctx.ui.setWidget(ULTRA_IGNITION_WIDGET_KEY, undefined);
      } catch {
        // The originating context can become stale after session replacement.
      }
    }, 1600);
    ignitionTimer.unref?.();
  }

  function persistState(): void {
    pi.appendEntry(
      ULTRA_STATE_ENTRY,
      enabled && fallbackLevel
        ? { enabled: true, fallbackLevel }
        : { enabled },
    );
  }

  function disable(ctx: ExtensionContext, persist = true): void {
    enabled = false;
    fallbackLevel = undefined;
    if (persist) persistState();
    updateStatus(ctx);
    clearIgnition(ctx);
  }

  function taskAgentNotice(): { message: string; level: "info" | "warning" } {
    if (pi.getActiveTools().includes("task_agent")) {
      return {
        message: "Effort set to Ultra (wire effort: max; proactive multi-agent delegation enabled).",
        level: "info",
      };
    }
    const installed = pi.getAllTools().some((tool) => tool.name === "task_agent");
    return installed
      ? {
          message: "Effort set to Ultra (wire effort: max), but task_agent is not active; proactive delegation is unavailable.",
          level: "warning",
        }
      : {
          message: "Effort set to Ultra (wire effort: max), but task_agent is not installed; this session only gets Max reasoning.",
          level: "warning",
        };
  }

  function enable(ctx: ExtensionContext, options: UltraEnableOptions = {}): boolean {
    const model = ctx.model;
    if (!model || !isUltraCapableModel(model)) {
      if (options.notify !== false) {
        ctx.ui.notify(
          `Ultra is available for openai-codex/gpt-5.6-sol and openai-codex/gpt-5.6-terra; current model is ${model ? `${model.provider}/${model.id}` : "unknown"}.`,
          "warning",
        );
      }
      return false;
    }

    const wasEnabled = enabled;
    const previousLevel = currentNativeLevel() ?? "medium";
    const fallback = wasEnabled ? fallbackLevel ?? previousLevel : previousLevel;
    pi.setThinkingLevel(NATIVE_ULTRA_LEVEL as PiThinkingLevel);
    if (!isNativeMax()) {
      pi.setThinkingLevel(previousLevel as PiThinkingLevel);
      if (options.notify !== false) {
        ctx.ui.notify(
          `Current ${model.provider}/${model.id} configuration does not expose native max effort; Ultra was not enabled.`,
          "warning",
        );
      }
      return false;
    }

    enabled = true;
    fallbackLevel = fallback;
    if (options.persist !== false) persistState();
    updateStatus(ctx);
    if (!wasEnabled && options.flash !== false) flashIgnition(ctx);
    if (options.notify !== false) {
      const notice = taskAgentNotice();
      ctx.ui.notify(notice.message, notice.level);
    }
    return true;
  }

  const handle: UltraHandle = {
    isEnabled: () => enabled,
    isCapable: isUltraCapableModel,
    enable,
    disable,
  };
  // Attach synchronously so effort can resolve the controller after extension loading.
  attachUltraHandle(pi, handle);

  function restore(ctx: ExtensionContext): void {
    const restored = restoreUltraStateFromBranch(ctx.sessionManager.getBranch());
    enabled = false;
    fallbackLevel = undefined;

    if (restored?.enabled && isUltraCapableModel(ctx.model)) {
      const previousLevel = currentNativeLevel() ?? "medium";
      enabled = true;
      fallbackLevel = restored.fallbackLevel ?? previousLevel;
      pi.setThinkingLevel(NATIVE_ULTRA_LEVEL as PiThinkingLevel);
      if (!isNativeMax()) {
        enabled = false;
        fallbackLevel = undefined;
        pi.setThinkingLevel(previousLevel as PiThinkingLevel);
        if (ctx.hasUI) {
          ctx.ui.notify("Saved Ultra state could not be restored because native max is unavailable.", "warning");
        }
      }
    }
    updateStatus(ctx);
  }

  // Codex MultiAgentV2 always carries an explicit mode. Ultra selects proactive;
  // every other Sol/Terra effort keeps delegation explicit-request-only.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!isUltraCapableModel(ctx.model)) return;
    return {
      systemPrompt: upsertMultiAgentModePrompt(
        event.systemPrompt,
        enabled && isNativeMax() ? "proactive" : "explicit",
      ),
    };
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (enabled && String(event.level) !== NATIVE_ULTRA_LEVEL) disable(ctx, true);
  });

  pi.on("model_select", async (event, ctx) => {
    if (enabled && (!isUltraCapableModel(event.model) || !isNativeMax())) {
      disable(ctx, true);
    } else {
      updateStatus(ctx);
    }
  });

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (_event, ctx) => restore(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    // Codex keeps Ultra conversation-scoped and retains a non-Ultra config
    // fallback. Pi's public setter also updates its global default, so restore
    // that fallback at graceful shutdown while leaving ultra/state intact.
    const fallback = fallbackLevel;
    const shouldRestoreFallback = enabled && fallback && isNativeMax();
    enabled = false;
    fallbackLevel = undefined;
    if (shouldRestoreFallback) pi.setThinkingLevel(fallback as PiThinkingLevel);

    clearIgnition(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(ULTRA_STATUS_KEY, undefined);
  });
}
