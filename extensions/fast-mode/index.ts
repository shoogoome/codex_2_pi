import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FAST_MODE_STATE_ENTRY,
  applyFastServiceTier,
  getFastAvailability,
  restoreFastModeState,
  type FastAvailability,
  type FastModeState,
  type FastModel,
} from "./core.js";

const STATUS_KEY = "fast-mode";
const COMMAND_ARGS = ["status", "on", "off"] as const;

type CurrentModel = Model<any> | undefined;

function modelLabel(model: CurrentModel): string {
  return model ? `${model.provider}/${model.id}` : "no active model";
}

function availabilityMessage(model: CurrentModel, availability: FastAvailability): string {
  if (availability.active) {
    return `Fast mode is on for ${modelLabel(model)} (service tier: priority; increased usage).`;
  }
  switch (availability.reason) {
    case "no-model":
      return "Fast mode requires an active Codex model.";
    case "unsupported-model":
      return `Fast mode is unavailable for ${modelLabel(model)}. Supported models: GPT-6 Astra, GPT-5.6 Sol/Terra/Luna, GPT-5.5, and GPT-5.4.`;
    case "oauth-required":
      return "Fast mode requires openai-codex ChatGPT subscription OAuth; API-key requests are left unchanged.";
  }
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = false;

  pi.registerFlag("fast", {
    description: "Start this Pi session with Codex Fast mode enabled (priority service tier; increased usage).",
    type: "boolean",
    default: false,
  });

  function isUsingOAuth(ctx: ExtensionContext, model: CurrentModel): boolean {
    if (!model) return false;
    try {
      return ctx.modelRegistry.isUsingOAuth(model);
    } catch {
      return false;
    }
  }

  function availability(ctx: ExtensionContext, model: CurrentModel = ctx.model): FastAvailability {
    return getFastAvailability(model as FastModel | undefined, isUsingOAuth(ctx, model));
  }

  function updateStatus(ctx: ExtensionContext, model: CurrentModel = ctx.model): void {
    if (!ctx.hasUI) return;
    const active = enabled && availability(ctx, model).active;
    let label: string | undefined;
    if (active) {
      try {
        label = ctx.ui.theme.bold(ctx.ui.theme.fg("accent", "⚡ fast"));
      } catch {
        label = "⚡ fast";
      }
    }
    ctx.ui.setStatus(STATUS_KEY, label);
  }

  function persist(): void {
    try {
      pi.appendEntry<FastModeState>(FAST_MODE_STATE_ENTRY, { enabled });
    } catch {
      // Runtime behavior should still work if session persistence is unavailable.
    }
  }

  function setEnabled(next: boolean, ctx: ExtensionContext): void {
    enabled = next;
    persist();
    updateStatus(ctx);
  }

  function enable(ctx: ExtensionContext): boolean {
    const currentAvailability = availability(ctx);
    if (!currentAvailability.active) {
      ctx.ui.notify(availabilityMessage(ctx.model, currentAvailability), "warning");
      return false;
    }
    setEnabled(true, ctx);
    ctx.ui.notify(availabilityMessage(ctx.model, currentAvailability), "info");
    return true;
  }

  function disable(ctx: ExtensionContext): void {
    setEnabled(false, ctx);
    ctx.ui.notify("Fast mode is off; Codex requests use the standard service tier.", "info");
  }

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast mode, or use `/fast on|off|status`",
    getArgumentCompletions: (prefix) => COMMAND_ARGS
      .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
      .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        if (enabled) disable(ctx);
        else enable(ctx);
        return;
      }
      if (action === "on") {
        if (enabled) {
          const currentAvailability = availability(ctx);
          ctx.ui.notify(
            currentAvailability.active
              ? availabilityMessage(ctx.model, currentAvailability)
              : `Fast mode is configured on but inactive. ${availabilityMessage(ctx.model, currentAvailability)}`,
            currentAvailability.active ? "info" : "warning",
          );
        } else {
          enable(ctx);
        }
        return;
      }
      if (action === "off") {
        if (enabled) disable(ctx);
        else ctx.ui.notify("Fast mode is already off.", "info");
        return;
      }
      if (action === "status") {
        if (!enabled) {
          ctx.ui.notify("Fast mode is off.", "info");
          return;
        }
        const currentAvailability = availability(ctx);
        ctx.ui.notify(
          currentAvailability.active
            ? availabilityMessage(ctx.model, currentAvailability)
            : `Fast mode is configured on but inactive. ${availabilityMessage(ctx.model, currentAvailability)}`,
          currentAvailability.active ? "info" : "warning",
        );
        return;
      }
      ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const nextPayload = applyFastServiceTier(event.payload, {
      enabled,
      model: ctx.model as FastModel | undefined,
      usingOAuth: isUsingOAuth(ctx, ctx.model),
    });
    return nextPayload === event.payload ? undefined : nextPayload;
  });

  function restore(ctx: ExtensionContext): void {
    const restored = restoreFastModeState(ctx.sessionManager.getBranch());
    enabled = restored?.enabled === true || pi.getFlag("fast") === true;
    updateStatus(ctx);
  }

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (_event, ctx) => restore(ctx));
  pi.on("model_select", async (event, ctx) => updateStatus(ctx, event.model));
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
