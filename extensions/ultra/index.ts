import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  type NativeThinkingLevel,
  TASK_AGENT_TOOL_NAME,
  ULTRA_IGNITION_WIDGET_KEY,
  ULTRA_STATE_ENTRY,
  ULTRA_STATUS_KEY,
  type UltraWorkflowState,
  getUltraWorkflowState,
  isNativeThinkingLevel,
  isUltraCapableModel,
  restoreUltraStateFromBranch,
  toolsForUltraTaskAgentActivation,
  upsertMultiAgentModePrompt,
  upsertUltraWorkflowPrompt,
} from "./core.js";
import {
  attachUltraHandle,
  type UltraEnableOptions,
  type UltraHandle,
} from "./handle.js";

const NATIVE_ULTRA_LEVEL = "max";
type PiThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

interface WorkflowActivationResult {
  state: UltraWorkflowState;
  autoEnabled: boolean;
}

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
  let taskAgentAddedByUltra = false;

  function currentNativeLevel(): NativeThinkingLevel | undefined {
    const level = String(pi.getThinkingLevel());
    return isNativeThinkingLevel(level) ? level : undefined;
  }

  function isNativeMax(): boolean {
    return currentNativeLevel() === NATIVE_ULTRA_LEVEL;
  }

  function availableToolNames(): string[] {
    return pi.getAllTools().map((tool) => tool.name);
  }

  function workflowState(): UltraWorkflowState {
    return getUltraWorkflowState(pi.getActiveTools(), availableToolNames());
  }

  function ensureTaskAgentForUltra(): WorkflowActivationResult {
    const activeTools = pi.getActiveTools();
    const availableTools = availableToolNames();
    const nextTools = toolsForUltraTaskAgentActivation(activeTools, availableTools);
    if (!nextTools) {
      const state = getUltraWorkflowState(activeTools, availableTools);
      if (state === "paused-plan-mode") releaseTaskAgentAddedByUltra();
      return { state, autoEnabled: false };
    }

    try {
      pi.setActiveTools(nextTools);
      taskAgentAddedByUltra = true;
      return { state: "active", autoEnabled: true };
    } catch {
      return { state: "paused-task-agent-inactive", autoEnabled: false };
    }
  }

  function releaseTaskAgentAddedByUltra(): void {
    if (!taskAgentAddedByUltra) return;
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes(TASK_AGENT_TOOL_NAME)) {
      // Plan mode temporarily hides the tool but later restores its pre-plan set.
      // Retain ownership so the first non-plan turn can finish the cleanup.
      if (!activeTools.includes(EXIT_PLAN_MODE_TOOL_NAME)) taskAgentAddedByUltra = false;
      return;
    }
    try {
      pi.setActiveTools(activeTools.filter((name) => name !== TASK_AGENT_TOOL_NAME));
      // Plan mode can later restore its captured pre-plan set, including this tool.
      // Retain ownership until a non-plan turn confirms that cleanup is complete.
      taskAgentAddedByUltra = activeTools.includes(EXIT_PLAN_MODE_TOOL_NAME);
    } catch {
      // Keep ownership so a later lifecycle hook can retry without touching other tools.
    }
  }

  function statusText(state: UltraWorkflowState): string {
    switch (state) {
      case "active":
        return "» ULTRA · workflow active";
      case "paused-plan-mode":
        return "» ULTRA · workflow paused (plan mode)";
      case "paused-task-agent-inactive":
        return "» ULTRA · workflow paused (task_agent inactive)";
      case "paused-task-agent-unavailable":
        return "» ULTRA · workflow paused (task_agent unavailable)";
    }
  }

  function styledStatus(ctx: ExtensionContext, state: UltraWorkflowState): string {
    const text = statusText(state);
    try {
      return ctx.ui.theme.bold(ctx.ui.theme.fg("accent", text));
    } catch {
      return text;
    }
  }

  function updateStatus(ctx: ExtensionContext, state?: UltraWorkflowState): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      ULTRA_STATUS_KEY,
      enabled ? styledStatus(ctx, state ?? workflowState()) : undefined,
    );
  }

  function clearIgnition(ctx: ExtensionContext): void {
    if (ignitionTimer) {
      clearTimeout(ignitionTimer);
      ignitionTimer = undefined;
    }
    if (ctx.hasUI) ctx.ui.setWidget(ULTRA_IGNITION_WIDGET_KEY, undefined);
  }

  function ignitionDetail(state: UltraWorkflowState): string {
    switch (state) {
      case "active":
        return "Maximum reasoning · multi-agent workflow active";
      case "paused-plan-mode":
        return "Maximum reasoning · workflow paused: plan mode";
      case "paused-task-agent-inactive":
        return "Maximum reasoning · workflow paused: task_agent inactive";
      case "paused-task-agent-unavailable":
        return "Maximum reasoning · workflow paused: task_agent unavailable";
    }
  }

  function flashIgnition(ctx: ExtensionContext, state: UltraWorkflowState): void {
    if (!ctx.hasUI) return;
    clearIgnition(ctx);
    let headline = "» ULTRA";
    let detail = ignitionDetail(state);
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
    releaseTaskAgentAddedByUltra();
    if (persist) persistState();
    updateStatus(ctx);
    clearIgnition(ctx);
  }

  function taskAgentNotice(
    activation: WorkflowActivationResult,
    action = "Effort set to Ultra",
  ): { message: string; level: "info" | "warning" } {
    switch (activation.state) {
      case "active":
        return {
          message: activation.autoEnabled
            ? `${action} (wire effort: max; multi-agent workflow active; task_agent auto-enabled).`
            : `${action} (wire effort: max; multi-agent workflow active).`,
          level: "info",
        };
      case "paused-plan-mode":
        return {
          message: `${action} (wire effort: max; multi-agent workflow paused: plan mode read-only gate is active).`,
          level: "warning",
        };
      case "paused-task-agent-inactive":
        return {
          message: `${action} (wire effort: max; multi-agent workflow paused: task_agent could not be activated).`,
          level: "warning",
        };
      case "paused-task-agent-unavailable":
        return {
          message: `${action} (wire effort: max; multi-agent workflow paused: task_agent is not installed).`,
          level: "warning",
        };
    }
  }

  function enable(ctx: ExtensionContext, options: UltraEnableOptions = {}): boolean {
    const model = ctx.model;
    if (!model || !isUltraCapableModel(model)) {
      if (options.notify !== false) {
        ctx.ui.notify(
          `Ultra requires an active model with native max effort; current model is ${model ? `${model.provider}/${model.id}` : "unknown"}.`,
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
    const activation = ensureTaskAgentForUltra();
    if (options.persist !== false) persistState();
    updateStatus(ctx, activation.state);
    if (!wasEnabled && options.flash !== false) flashIgnition(ctx, activation.state);
    if (options.notify !== false) {
      const notice = taskAgentNotice(activation);
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

  function restore(ctx: ExtensionContext, notifyWorkflow: boolean): void {
    const restored = restoreUltraStateFromBranch(ctx.sessionManager.getBranch());
    enabled = false;
    fallbackLevel = undefined;
    let activation: WorkflowActivationResult | undefined;

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
      } else {
        activation = ensureTaskAgentForUltra();
      }
    }

    if (!enabled) releaseTaskAgentAddedByUltra();
    updateStatus(ctx, activation?.state);
    if (notifyWorkflow && ctx.hasUI && activation) {
      const notice = taskAgentNotice(activation, "Ultra restored");
      ctx.ui.notify(notice.message, notice.level);
    }
  }

  // Codex MultiAgentV2 always carries an explicit mode. Ultra selects proactive;
  // every non-Ultra effort keeps delegation explicit-request-only. The
  // Ultra-owned workflow block is present only while its task tool is usable.
  pi.on("before_agent_start", async (event, ctx) => {
    const capable = isUltraCapableModel(ctx.model);
    const ultraActive = capable && enabled && isNativeMax();
    let workflowActive = false;

    if (ultraActive) {
      const activation = ensureTaskAgentForUltra();
      workflowActive = activation.state === "active";
      updateStatus(ctx, activation.state);
    } else {
      releaseTaskAgentAddedByUltra();
    }

    const modePrompt = capable
      ? upsertMultiAgentModePrompt(event.systemPrompt, ultraActive ? "proactive" : "explicit")
      : event.systemPrompt;
    return {
      systemPrompt: upsertUltraWorkflowPrompt(modePrompt, workflowActive),
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

  pi.on("session_start", async (_event, ctx) => restore(ctx, true));
  pi.on("session_tree", async (_event, ctx) => restore(ctx, true));
  pi.on("session_compact", async (_event, ctx) => restore(ctx, false));

  pi.on("session_shutdown", async (_event, ctx) => {
    // Codex keeps Ultra conversation-scoped and retains a non-Ultra config
    // fallback. Pi's public setter also updates its global default, so restore
    // that fallback at graceful shutdown while leaving ultra/state intact.
    const fallback = fallbackLevel;
    const shouldRestoreFallback = enabled && fallback && isNativeMax();
    releaseTaskAgentAddedByUltra();
    taskAgentAddedByUltra = false;
    enabled = false;
    fallbackLevel = undefined;
    if (shouldRestoreFallback) pi.setThinkingLevel(fallback as PiThinkingLevel);

    clearIgnition(ctx);
    if (ctx.hasUI) ctx.ui.setStatus(ULTRA_STATUS_KEY, undefined);
  });
}
