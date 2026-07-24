import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
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
      if (typeof (ctx as any).ui?.custom === "function" && ctx.hasUI) {
        await handlePicker(ctx, options);
      } else {
        await handleList(ctx, options);
      }
      return;
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

async function handlePicker(
  ctx: ExtensionCommandContext | ExtensionContext,
  options: HandlePetsOptions,
): Promise<void> {
  const settings = await loadSettings(options.agentDir);
  const builtins = builtinPets().map((pet) => ({
    value: pet.id,
    label: pet.displayName,
    description: pet.description,
  }));
  const customDir = join(options.agentDir, "pets");
  let custom: { value: string; label: string; description: string }[] = [];
  if (existsSync(customDir)) {
    const entries = await readdir(customDir, { withFileTypes: true });
    custom = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ value: entry.name, label: entry.name, description: "custom pet" }));
  }
  const items = [
    { value: "disabled", label: "Disable terminal pets", description: "Hide the pet widget." },
    ...builtins,
    ...custom,
  ];

  if (typeof (ctx as any).ui?.custom !== "function") {
    await handleList(ctx, options);
    return;
  }

  const pick = await (ctx as any).ui.custom((tui: any, theme: any, _kb: any, done: (value: string | null) => void) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select Pet")), 1, 0));
    const select = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    (select as any).onSelect = (item: any) => done(item.value);
    (select as any).onCancel = () => done(null);
    container.addChild(select);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    const component: any = {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        (select as any).handleInput?.(data);
        tui.requestRender();
      },
      __items: items, // for tests
    };
    return component;
  });

  if (!pick) return;
  if (pick === "disabled") {
    await saveSettings(options.agentDir, { ...settings, enabled: false });
    ctx.ui.notify("Pet disabled.");
    return;
  }
  await saveSettings(options.agentDir, { ...settings, selectedPet: pick, enabled: true });
  ctx.ui.notify(`Pet set to ${pick}.`);
}
