import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadFastModeSettings } from "./settings.js";
import { publishFastModeReader } from "./handle.js";
import { isForkWorker } from "../localagent/workerIdentity.js";
import {
  FAST_MODE_STATE_ENTRY,
  FAST_SERVICE_TIER,
  ULTRAFAST_SERVICE_TIER,
  applyFastServiceTier,
  getFastAvailability,
  restoreFastModeState,
  type FastAvailability,
  type FastModeState,
  type FastModel,
  type SpeedServiceTier,
} from "./core.js";

const STATUS_KEY = "fast-mode";
const COMMAND_ARGS = ["status", "on", "off"] as const;
const REQUEST_TIMING_NOTICE = "Applies to the next provider request; an in-flight response is unchanged. Server routing is not verified.";
const ULTRAFAST_NOTICE = "Account entitlement is not verified: UltraFast requires Pro $500 or eligible Enterprise/Edu; Pro $200 is not supported. Included usage is consumed at 8x Standard (purchased credits: 6x). Server authorization still applies; no automatic fallback.";

type CurrentModel = Model<any> | undefined;

function modeName(tier: SpeedServiceTier): string {
  return tier === ULTRAFAST_SERVICE_TIER ? "UltraFast" : "Fast";
}

function modelLabel(model: CurrentModel): string {
  return model ? `${model.provider}/${model.id}` : "no active model";
}

function availabilityMessage(model: CurrentModel, availability: FastAvailability, tier: SpeedServiceTier): string {
  const name = modeName(tier);
  if (availability.active) {
    return `${name} mode is configured on for ${modelLabel(model)} (service tier: ${tier}; increased usage). ${REQUEST_TIMING_NOTICE}${tier === ULTRAFAST_SERVICE_TIER ? ` ${ULTRAFAST_NOTICE}` : ""}`;
  }
  switch (availability.reason) {
    case "no-model":
      return `${name} mode requires an active Codex model.`;
    case "unsupported-model":
      return `${name} mode is unavailable for ${modelLabel(model)}. It requires an OpenAI Codex Responses model.`;
    case "oauth-required":
      return `${name} mode requires openai-codex ChatGPT subscription OAuth; API-key requests are left unchanged.`;
  }
}

export default function fastModeExtension(
  pi: ExtensionAPI,
  dependencies: { loadSettings?: typeof loadFastModeSettings } = {},
): void {
  const loadSettings = dependencies.loadSettings ?? loadFastModeSettings;
  let enabled = false;
  let tier: SpeedServiceTier = FAST_SERVICE_TIER;
  publishFastModeReader(pi, () => ({ enabled, tier }));

  pi.registerFlag("fast", {
    description: "Start this Pi session with Codex Fast mode enabled (priority service tier; increased usage).",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("ultrafast", {
    description: "Request UltraFast routing for GPT models (requires eligible subscription; increased usage). Takes precedence over --fast.",
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
    return getFastAvailability(model as FastModel | undefined, isUsingOAuth(ctx, model), tier);
  }

  function updateStatus(ctx: ExtensionContext, model: CurrentModel = ctx.model): void {
    if (!ctx.hasUI) return;
    const active = enabled && availability(ctx, model).active;
    let label: string | undefined;
    if (active) {
      const text = tier === ULTRAFAST_SERVICE_TIER ? "⚡ ultrafast (requested)" : "⚡ fast";
      try {
        label = ctx.ui.theme.bold(ctx.ui.theme.fg("accent", text));
      } catch {
        label = text;
      }
    }
    ctx.ui.setStatus(STATUS_KEY, label);
  }

  function persist(): void {
    try {
      const state: FastModeState = tier === FAST_SERVICE_TIER ? { enabled } : { enabled, tier };
      pi.appendEntry<FastModeState>(FAST_MODE_STATE_ENTRY, state);
    } catch {
      // Runtime behavior should still work if session persistence is unavailable.
    }
  }

  function report(ctx: ExtensionContext): void {
    const currentAvailability = availability(ctx);
    ctx.ui.notify(
      currentAvailability.active
        ? availabilityMessage(ctx.model, currentAvailability, tier)
        : `${modeName(tier)} mode is configured on but inactive. ${availabilityMessage(ctx.model, currentAvailability, tier)}`,
      currentAvailability.active ? "info" : "warning",
    );
  }

  function enable(nextTier: SpeedServiceTier, ctx: ExtensionContext): void {
    const currentAvailability = getFastAvailability(ctx.model as FastModel | undefined, isUsingOAuth(ctx, ctx.model), nextTier);
    if (!currentAvailability.active) {
      ctx.ui.notify(availabilityMessage(ctx.model, currentAvailability, nextTier), "warning");
      return;
    }
    enabled = true;
    tier = nextTier;
    persist();
    updateStatus(ctx);
    ctx.ui.notify(availabilityMessage(ctx.model, currentAvailability, tier), tier === ULTRAFAST_SERVICE_TIER ? "warning" : "info");
  }

  function disable(ctx: ExtensionContext): void {
    const name = modeName(tier);
    enabled = false;
    persist();
    updateStatus(ctx);
    ctx.ui.notify(`${name} mode is off; this extension no longer overrides the service tier. ${REQUEST_TIMING_NOTICE}`, "info");
  }

  for (const [command, commandTier] of [["fast", FAST_SERVICE_TIER], ["ultrafast", ULTRAFAST_SERVICE_TIER]] as const) {
    pi.registerCommand(command, {
      description: `Toggle Codex ${modeName(commandTier)} mode, or use \`/${command} on|off|status\``,
      getArgumentCompletions: (prefix) => COMMAND_ARGS
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase();
        const selected = enabled && tier === commandTier;
        if (!action) {
          if (selected) disable(ctx);
          else enable(commandTier, ctx);
          return;
        }
        if (action === "on") {
          if (selected) report(ctx);
          else enable(commandTier, ctx);
          return;
        }
        if (action === "off") {
          if (selected) disable(ctx);
          else ctx.ui.notify(`${modeName(commandTier)} mode is already off.`, "info");
          return;
        }
        if (action === "status") {
          if (selected) report(ctx);
          else ctx.ui.notify(`${modeName(commandTier)} mode is off.${enabled ? ` ${modeName(tier)} mode is configured on instead.` : ""}`, "info");
          return;
        }
        ctx.ui.notify(`Usage: /${command} [on|off|status]`, "warning");
      },
    });
  }

  pi.on("before_provider_request", (event, ctx) => {
    // A fork has an explicit parent-owned routing hook. Local defaults and
    // compaction-restored Fast state must not override it (including parent off).
    if (isForkWorker(ctx.sessionManager.getSessionFile?.())) return;
    const nextPayload = applyFastServiceTier(event.payload, {
      enabled,
      tier,
      model: ctx.model as FastModel | undefined,
      usingOAuth: isUsingOAuth(ctx, ctx.model),
    });
    return nextPayload === event.payload ? undefined : nextPayload;
  });

  function restore(ctx: ExtensionContext): void {
    const restored = restoreFastModeState(ctx.sessionManager.getBranch());
    if (restored) {
      enabled = restored.enabled;
      tier = restored.tier ?? FAST_SERVICE_TIER;
    } else {
      const settings = loadSettings(getAgentDir(), ctx.cwd);
      if (ctx.hasUI) {
        for (const warning of settings.warnings) ctx.ui.notify(warning, "warning");
      }
      const ultraFlag = pi.getFlag("ultrafast") === true;
      const fastFlag = pi.getFlag("fast") === true;
      const mode = ultraFlag ? "ultrafast" : fastFlag ? "fast" : settings.mode;
      enabled = mode !== "off";
      tier = mode === "ultrafast" ? ULTRAFAST_SERVICE_TIER : FAST_SERVICE_TIER;
    }
    updateStatus(ctx);
    if (enabled && tier === ULTRAFAST_SERVICE_TIER && ctx.hasUI) {
      ctx.ui.notify(`${ULTRAFAST_NOTICE}${availability(ctx).active ? "" : ` ${availabilityMessage(ctx.model, availability(ctx), tier)}`}`, "warning");
    }
  }

  pi.on("session_start", async (_event, ctx) => restore(ctx));
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_compact", async (_event, ctx) => restore(ctx));
  pi.on("model_select", async (event, ctx) => updateStatus(ctx, event.model));
  pi.on("session_shutdown", async (_event, ctx) => {
    enabled = false;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
