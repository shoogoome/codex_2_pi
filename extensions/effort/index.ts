import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { getUltraHandle } from "../ultra/handle.js";
import {
  selectModelAndEffort,
  selectReasoningEffort,
} from "./picker.js";
import {
  type EffortLevel,
  type NativeThinkingLevel,
  defaultEffortForModel,
  effortLabel,
  isAdvancedEffort,
  isNativeThinkingLevel,
  nextEffort,
  reasoningOptionsForModel,
} from "./reasoning.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const COMMAND_LEVELS = ["status", ...LEVELS] as const;
const DECREASE_REASONING_KEY: KeyId = "alt+,";
const INCREASE_REASONING_KEY: KeyId = "alt+.";

type PiThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

/**
 * Generic reasoning-effort UI.
 *
 * Native levels, model/effort selectors, and stepping shortcuts live here.
 * Codex Ultra's state/request/orchestration lifecycle lives in extensions/ultra
 * and is reached through its pi.events-backed handle.
 */
export default function effortExtension(pi: ExtensionAPI): void {
  let modelInputUnsubscribe: (() => void) | undefined;

  function currentNativeLevel(): NativeThinkingLevel | undefined {
    const level = String(pi.getThinkingLevel());
    return isNativeThinkingLevel(level) ? level : undefined;
  }

  function ultraEnabled(): boolean {
    return getUltraHandle(pi)?.isEnabled() === true;
  }

  function isUltraCapable(model: NonNullable<ExtensionContext["model"]> | undefined): boolean {
    return getUltraHandle(pi)?.isCapable(model) === true;
  }

  function currentEffort(): EffortLevel | undefined {
    return ultraEnabled() ? "ultra" : currentNativeLevel();
  }

  function applyEffort(
    level: EffortLevel,
    ctx: ExtensionContext,
    options: { notify?: boolean; flash?: boolean } = {},
  ): boolean {
    const ultra = getUltraHandle(pi);
    if (level === "ultra") {
      if (!ultra) {
        if (options.notify !== false) {
          ctx.ui.notify(
            "Codex Ultra controller is unavailable. Ensure extensions/ultra is installed and loaded.",
            "warning",
          );
        }
        return false;
      }
      return ultra.enable(ctx, options);
    }

    if (ultra?.isEnabled()) ultra.disable(ctx, true);
    pi.setThinkingLevel(level as PiThinkingLevel);
    if (options.notify !== false) {
      ctx.ui.notify(`Effort set to ${level} (effective: ${pi.getThinkingLevel()})`, "info");
    }
    return String(pi.getThinkingLevel()) === level;
  }

  async function openEffortPicker(ctx: ExtensionContext): Promise<void> {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No active model is available for reasoning selection.", "warning");
      return;
    }
    const selected = await selectReasoningEffort(
      ctx,
      model,
      currentEffort(),
      isUltraCapable(model),
    );
    if (selected) applyEffort(selected, ctx);
  }

  async function openModelPicker(ctx: ExtensionContext, searchTerm?: string): Promise<void> {
    const selection = await selectModelAndEffort(
      ctx,
      searchTerm,
      currentEffort(),
      (model) => isUltraCapable(model),
    );
    if (!selection) return;

    // Keep the previous composite state until the model switch succeeds. No
    // agent request can start inside this awaited transition; applyEffort below
    // then atomically leaves or re-enters Ultra for the selected model.
    const sameModel = ctx.model?.provider === selection.model.provider
      && ctx.model?.id === selection.model.id;
    if (!sameModel) {
      const changed = await pi.setModel(selection.model);
      if (!changed) {
        ctx.ui.notify(
          `No authentication is configured for ${selection.model.provider}/${selection.model.id}.`,
          "warning",
        );
        return;
      }
    }
    applyEffort(selection.effort, ctx, { notify: false });
  }

  function installModelCommandInterceptor(ctx: ExtensionContext): void {
    modelInputUnsubscribe?.();
    modelInputUnsubscribe = undefined;
    if (!ctx.hasUI) return;

    // Pi's built-in /model selector cannot express Ultra because Ultra is a
    // client-side composite state, not a provider wire effort. Intercept only
    // the submit of /model and preserve every other editor/input behavior.
    modelInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "enter")) return undefined;
      const editorText = ctx.ui.getEditorText().trim();
      const match = /^\/model(?:\s+(.*))?$/.exec(editorText);
      if (!match) return undefined;

      ctx.ui.setEditorText("");
      const searchTerm = match[1]?.trim() || undefined;
      queueMicrotask(() => {
        void openModelPicker(ctx, searchTerm).catch((error) => {
          try {
            ctx.ui.notify(`Model/effort picker failed: ${String(error)}`, "error");
          } catch {
            // Ignore a stale UI after session replacement.
          }
        });
      });
      return { consume: true };
    });
  }

  function currentMessage(): string {
    const current = ultraEnabled()
      ? "ultra (wire: max; proactive delegation)"
      : String(pi.getThinkingLevel());
    return `Current effort: ${current}`;
  }

  pi.registerCommand("effort", {
    description: "Select reasoning effort; Max/Ultra use an explicit advanced picker",
    getArgumentCompletions: (prefix: string) => {
      const items = COMMAND_LEVELS.map((level) => ({ value: level, label: level }));
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const level = args.trim().toLowerCase();
      if (!level) {
        if (ctx.hasUI) await openEffortPicker(ctx);
        else ctx.ui.notify(currentMessage(), "info");
        return;
      }
      if (level === "status") {
        ctx.ui.notify(currentMessage(), "info");
        return;
      }
      if (!(LEVELS as readonly string[]).includes(level)) {
        ctx.ui.notify(`Unknown effort level "${level}". Options: ${COMMAND_LEVELS.join(", ")}`, "warning");
        return;
      }
      applyEffort(level as EffortLevel, ctx);
    },
  });

  async function handleReasoningShortcut(
    direction: "lower" | "raise",
    ctx: ExtensionContext,
  ): Promise<void> {
    const options = reasoningOptionsForModel(ctx.model, isUltraCapable(ctx.model));
    const configured = currentEffort();
    const anchor = defaultEffortForModel(options, configured);
    if (!anchor) {
      ctx.ui.notify(`Reasoning shortcuts are unavailable for ${ctx.model?.id ?? "this model"}.`, "warning");
      return;
    }
    const next = nextEffort(options, anchor, direction);
    if (!next) {
      ctx.ui.notify(
        `Reasoning is already at the ${direction === "lower" ? "lowest" : "highest"} level (${effortLabel(anchor).toLowerCase()}).`,
        "info",
      );
      return;
    }
    if (direction === "raise" && isAdvancedEffort(next)) {
      const advanced = options.filter((option) => option.advanced).map((option) => option.label).join(" and ");
      ctx.ui.notify(
        `${advanced} ${advanced.includes(" and ") ? "are" : "is"} available under /model → ${ctx.model?.id ?? "current model"} → More reasoning… (or /effort).`,
        "info",
      );
      return;
    }
    applyEffort(next, ctx, { notify: false });
  }

  pi.registerShortcut(DECREASE_REASONING_KEY, {
    description: "Decrease reasoning effort (Ultra lowers to Max)",
    handler: async (ctx) => handleReasoningShortcut("lower", ctx),
  });
  pi.registerShortcut(INCREASE_REASONING_KEY, {
    description: "Increase reasoning effort without crossing into Max/Ultra",
    handler: async (ctx) => handleReasoningShortcut("raise", ctx),
  });

  pi.on("session_start", async (_event, ctx) => installModelCommandInterceptor(ctx));
  pi.on("session_shutdown", async () => {
    modelInputUnsubscribe?.();
    modelInputUnsubscribe = undefined;
  });
}
