import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { builtinPet, builtinPets } from "../catalog/catalog.js";
import { detectPetCapability, type ExecResult } from "../render/capability.js";
import { selectRenderer } from "../render/select-renderer.js";
import { defaultSettings, loadSettings, saveSettings, type PetSettings } from "../config/settings.js";

export interface HandlePetsOptions {
  agentDir: string;
  /** Optional tmux probe injection. When omitted, diagnose reports tmux as unavailable. */
  execTmux?: (args: string[]) => Promise<ExecResult>;
}

export async function handlePetsCommand(
  args: string,
  ctx: ExtensionCommandContext | ExtensionContext,
  options: HandlePetsOptions,
): Promise<void> {
  const trimmed = args.trim();
  const [subcommand, ...rest] = trimmed.split(/\s+/);

  switch (subcommand) {
    case "":
    case "list":
      await handleList(ctx, options);
      return;
    case "set":
      await handleSet(ctx, options, rest.join(" ").trim());
      return;
    case "on":
      await handleEnabled(ctx, options, true);
      return;
    case "off":
      await handleEnabled(ctx, options, false);
      return;
    case "diagnose":
      await handleDiagnose(ctx, options);
      return;
    case "tmux-passthrough":
      await handleTmuxPassthrough(ctx, options, rest.join(" ").trim());
      return;
    default:
      ctx.ui.notify(
        `Unknown /pets subcommand: ${subcommand}. Try: /pets list, /pets set <id>, /pets on, /pets off, /pets diagnose, /pets tmux-passthrough on|off`,
        "error",
      );
  }
}

async function handleList(
  ctx: { ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void } },
  options: HandlePetsOptions,
): Promise<void> {
  const builtins = builtinPets().map((pet) => `${pet.id} (built-in): ${pet.description}`);
  const customDir = join(options.agentDir, "pets");
  let customLines: string[] = [];
  if (existsSync(customDir)) {
    const entries = await readdir(customDir, { withFileTypes: true });
    customLines = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${entry.name} (custom): from ${join(customDir, entry.name)}`);
  }
  const lines = ["Available pets:", ...builtins, ...customLines];
  ctx.ui.notify(lines.join("\n"));
}

async function handleSet(
  ctx: { ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void } },
  options: HandlePetsOptions,
  id: string,
): Promise<void> {
  if (!id) {
    ctx.ui.notify("Usage: /pets set <id>", "error");
    return;
  }
  const known = builtinPet(id) !== undefined || existsSync(join(options.agentDir, "pets", id, "pet.json"));
  if (!known) {
    ctx.ui.notify(`unknown pet: ${id}`, "error");
    return;
  }
  const current = await loadSettings(options.agentDir);
  const next: PetSettings = { ...current, selectedPet: id, enabled: true };
  await saveSettings(options.agentDir, next);
  ctx.ui.notify(`Pet set to ${id}.`);
}

async function handleEnabled(
  ctx: { ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void } },
  options: HandlePetsOptions,
  enabled: boolean,
): Promise<void> {
  const current = await loadSettings(options.agentDir);
  const next: PetSettings = { ...current, enabled };
  await saveSettings(options.agentDir, next);
  ctx.ui.notify(enabled ? "Pet enabled." : "Pet disabled.");
}

async function handleTmuxPassthrough(
  ctx: { ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void } },
  options: HandlePetsOptions,
  value: string,
): Promise<void> {
  if (value !== "on" && value !== "off") {
    ctx.ui.notify("Usage: /pets tmux-passthrough on|off", "error");
    return;
  }
  const current = await loadSettings(options.agentDir);
  const next: PetSettings = { ...current, tmuxPassthrough: value === "on" };
  await saveSettings(options.agentDir, next);
  ctx.ui.notify(`tmux passthrough set to ${value}.`);
}

async function handleDiagnose(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: HandlePetsOptions,
): Promise<void> {
  const settings = await loadSettings(options.agentDir);
  const execTmux = options.execTmux ?? (async () => ({ ok: false, stdout: "", stderr: "exec not available" }));
  const capability = await detectPetCapability({
    env: process.env,
    execTmux,
  });
  const choice = selectRenderer({ settings, capability });
  const decision =
    choice.kind === "disabled"
      ? "disabled"
      : choice.kind === "image"
        ? `Image renderer${choice.wrapForTmux ? " (tmux DCS passthrough)" : ""}`
        : "BlockArt renderer";

  const lines = [
    `/pets diagnose`,
    `  selected pet:           ${settings.selectedPet}`,
    `  enabled:                ${settings.enabled}`,
    `  render mode:            ${settings.renderMode}`,
    `  pi-tui images:          ${capability.images ?? "none"}`,
    `  pi-tui trueColor:       ${capability.trueColor}`,
    `  in tmux:                ${capability.inTmux}`,
    `  tmux version:           ${capability.tmuxVersion ?? "unknown"}`,
    `  allow-passthrough:      ${capability.tmuxPassthroughEnabled === undefined ? "unknown" : capability.tmuxPassthroughEnabled ? "on" : "off"}`,
    `  tmux passthrough opt-in:${settings.tmuxPassthrough}`,
    `  decision:               ${decision}`,
  ];
  ctx.ui.notify(lines.join("\n"));
}

export const __test = { defaultSettings };
