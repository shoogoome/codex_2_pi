import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractFrames, type RgbaFrame } from "./loader/frames.js";
import { loadPet, type LoadedPet } from "./loader/pet-loader.js";
import { loadSettings, type PetSettings } from "./config/settings.js";
import { detectPetCapability, type ExecResult, type PetCapability } from "./render/capability.js";
import { selectRenderer } from "./render/select-renderer.js";
import { createImageRenderer, type ImageRenderer } from "./render/image-renderer.js";
import { renderBlockArt } from "./render/block-art.js";
import { PetState } from "./state/pet-state.js";
import { createPetComponent } from "./widget/pet-component.js";
import { installPetWidget, type InstalledWidgetHandle } from "./widget/pet-widget.js";
import { handlePetsCommand } from "./commands/pets-command.js";
import { FALLBACK_ASCII } from "./catalog/default/fallback.js";

const WAITING_TOOLS = ["request_user_input", "ask_user_question", "askUserQuestion"];
const REVIEW_LINGER_MS = 30_000;
const FAILED_LINGER_MS = 5 * 60_000;

interface RuntimeContext {
  widget?: InstalledWidgetHandle;
  state?: PetState;
  settings: PetSettings;
}

function getAgentDirOverride(): string {
  return process.env.PI_PETS_AGENT_DIR ?? getAgentDir();
}

export default async function petsExtension(pi: ExtensionAPI): Promise<void> {
  const runtime: RuntimeContext = {
    settings: {
      selectedPet: "default",
      enabled: true,
      placement: "belowEditor",
      tmuxPassthrough: false,
      renderMode: "auto",
    },
  };

  function makeExecTmux(): (args: string[]) => Promise<ExecResult> {
    return async (args) => {
      try {
        const result = await pi.exec("tmux", args, { timeout: 5000 });
        return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    };
  }

  pi.registerCommand("pets", {
    description: "Configure the Codex-style terminal pet (pet picker, diagnose, tmux passthrough).",
    handler: async (args, ctx) => {
      await handlePetsCommand(args, ctx, {
        agentDir: getAgentDirOverride(),
        execTmux: makeExecTmux(),
      });
      // Re-install widget so changes take effect immediately.
      await installFromSettings(runtime, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await installFromSettings(runtime, ctx);
  });

  pi.on("session_shutdown", async () => {
    runtime.widget?.uninstall();
    runtime.widget = undefined;
    runtime.state = undefined;
  });

  pi.on("agent_start", async () => {
    runtime.state?.onAgentStart();
  });

  pi.on("turn_start", async () => {
    runtime.state?.onAgentStart();
  });

  pi.on("turn_end", async (event) => {
    const message = (event as any).message;
    const stopReason = message?.stopReason as string | undefined;
    const errorMessage = message?.errorMessage as string | undefined;
    runtime.state?.onTurnEnd({ stopReason, errorMessage });
  });

  pi.on("agent_end", async (event) => {
    const messages = (event as any).messages as any[] | undefined;
    const last = messages?.[messages.length - 1];
    runtime.state?.onAgentEnd({
      stopReason: last?.stopReason,
      errorMessage: last?.errorMessage,
    });
  });

  pi.on("tool_execution_start", async (event) => {
    runtime.state?.onToolStart((event as any).toolName);
  });

  pi.on("tool_execution_end", async (event) => {
    runtime.state?.onToolEnd((event as any).toolName, Boolean((event as any).isError));
  });

  async function installFromSettings(
    runtimeCtx: RuntimeContext,
    ctx: ExtensionContext,
  ): Promise<void> {
    runtimeCtx.widget?.uninstall();
    runtimeCtx.widget = undefined;

    const agentDir = getAgentDirOverride();
    runtimeCtx.settings = await loadSettings(agentDir);

    if (!runtimeCtx.settings.enabled || !ctx.hasUI) {
      runtimeCtx.state = undefined;
      return;
    }

    const load = loadPet(runtimeCtx.settings.selectedPet, { agentDir });
    const pet: LoadedPet = load.pet;

    const capability: PetCapability = await detectPetCapability({
      env: process.env,
      execTmux: makeExecTmux(),
    });

    const choice = selectRenderer({ settings: runtimeCtx.settings, capability });
    if (choice.kind === "disabled") return;

    let frames: RgbaFrame[] | undefined;
    try {
      frames = await extractFrames(pet);
    } catch {
      frames = undefined;
    }

    runtimeCtx.state = new PetState({
      waitingTools: WAITING_TOOLS,
      reviewLingerMs: REVIEW_LINGER_MS,
      failedLingerMs: FAILED_LINGER_MS,
    });

    const imageRenderer: ImageRenderer | undefined = choice.kind === "image"
      ? createImageRenderer({
          theme: { fallbackColor: (s) => s },
          wrapForTmux: choice.wrapForTmux,
        })
      : undefined;

    runtimeCtx.widget = installPetWidget({
      ctx,
      placement: runtimeCtx.settings.placement,
      componentFactory: (tui) =>
        createPetComponent({
          state: runtimeCtx.state!,
          tui: tui as any,
          animationsByState: pet.manifest.animations,
          renderFrame: (stateName, frameIndex, width) => {
            if (choice.kind === "image" && imageRenderer && frames) {
              const frame = frames[frameIndex];
              const base64 = Buffer.from(frame.rgba).toString("base64");
              return imageRenderer.render(
                { frameKey: `${pet.id}:${frameIndex}`, base64, mime: "image/png" },
                width,
              );
            }
            if (frames) {
              return renderBlockArt({
                state: stateName,
                animationFrame: frames[frameIndex],
                blockArt: pet.manifest.blockArt,
                trueColor: capability.trueColor,
              });
            }
            return FALLBACK_ASCII[stateName];
          },
        }),
    });
  }
}
