import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { buildSessionContext, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, type Component, Container, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { collectImageEntries, type ImageEntry } from "./indexer.js";

export const MANUAL_IMAGE_CHOICE = "Enter path manually...";

export async function handleImagesCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/images requires interactive UI.", "warning");
    return;
  }

  const branch = ctx.sessionManager.getBranch() as any;
  const contextMessages = buildSessionContext(branch, ctx.sessionManager.getLeafId()).messages as any;
  const entries = collectImageEntries(branch, contextMessages);
  const choices = createImageChoices(entries, ctx.cwd);
  const choice = await ctx.ui.select("Images", choices);
  if (!choice) return;

  const selectedPath = choice === MANUAL_IMAGE_CHOICE
    ? await ctx.ui.input("Image path", "./path/to/image.png")
    : findEntryForChoice(entries, choice, ctx.cwd)?.path;
  if (!selectedPath) return;

  const absolutePath = resolveImagePath(selectedPath, ctx.cwd, homedir());
  const mimeType = detectImageMimeType(absolutePath);
  if (!mimeType) {
    ctx.ui.notify(`Unsupported image type: ${absolutePath}`, "error");
    return;
  }
  if (!existsSync(absolutePath)) {
    ctx.ui.notify(`Image not found: ${absolutePath}`, "error");
    return;
  }

  const capabilities = getCapabilities();
  if (!capabilities.images) {
    ctx.ui.notify(`当前终端不支持 inline image 预览，或正在 tmux/screen 中。图片路径：${absolutePath}`, "warning");
    return;
  }

  const data = readFileSync(absolutePath).toString("base64");
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new ImagePreviewComponent(theme, done, {
    path: absolutePath,
    data,
    mimeType,
  }), {
    overlay: true,
    overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
  });
}

export function createImageChoices(entries: ImageEntry[], cwd: string): string[] {
  return [MANUAL_IMAGE_CHOICE, ...entries.map((entry, index) => formatChoice(entry, cwd, index))];
}

export function findEntryForChoice(entries: ImageEntry[], choice: string, cwd: string): ImageEntry | undefined {
  return entries.find((entry, index) => formatChoice(entry, cwd, index) === choice);
}

export function resolveImagePath(path: string, cwd: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return path;
  return join(cwd, path);
}

export function detectImageMimeType(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return undefined;
}

function formatChoice(entry: ImageEntry, cwd: string, index: number): string {
  const displayPath = displayPathFor(entry.path, cwd);
  const prompt = entry.prompt ? ` — ${truncate(entry.prompt, 80)}` : "";
  return `${index + 1}. ${basename(entry.path)} — ${entry.source} — ${displayPath}${prompt}`;
}

function displayPathFor(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith("..")) return `./${rel}`;
  return path;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

class ImagePreviewComponent extends Container implements Component {
  constructor(
    theme: Theme,
    private done: () => void,
    image: { path: string; data: string; mimeType: string },
  ) {
    super();
    this.addChild(new Text(theme.bold("Image Preview"), 0, 0));
    this.addChild(new Text(theme.fg("dim", image.path), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new Image(image.data, image.mimeType, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 100, filename: basename(image.path) }));
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "Esc/Enter: close"), 0, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) this.done();
  }
}
