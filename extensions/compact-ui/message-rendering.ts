import { Markdown } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { prefixWrappedLines, trimVisualBlankEdges, type CompactThemeLike } from "./text.js";

export type RenderFn = (width: number) => string[];

export interface PatchableRenderPrototype {
  render: RenderFn;
  __codexCompactOriginalRender?: RenderFn;
  __codexCompactPatchKind?: "user" | "assistant";
  __codexCompactPatchVersion?: number;
}

const PATCH_VERSION = 1;

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractMarkdownText(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.text === "string") {
    return value.text;
  }

  if (!isRecord(value)) return undefined;

  const children = Array.isArray(value.children) ? value.children : [];
  for (const child of children) {
    const text = extractMarkdownText(child);
    if (text !== undefined) return text;
  }

  return undefined;
}

function renderMarkdownText(text: string, width: number): string[] {
  try {
    return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
  } catch {
    return text.split("\n");
  }
}

function patchPrototype(
  prototype: PatchableRenderPrototype,
  kind: "user" | "assistant",
  getTheme: () => CompactThemeLike | undefined,
): void {
  if (typeof prototype.render !== "function") return;
  if (prototype.__codexCompactPatchKind === kind && prototype.__codexCompactPatchVersion === PATCH_VERSION) return;

  if (!prototype.__codexCompactOriginalRender) {
    prototype.__codexCompactOriginalRender = prototype.render;
  }

  const original = prototype.__codexCompactOriginalRender;
  prototype.render = function compactRender(this: unknown, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    let originalLines: string[];
    try {
      originalLines = original.call(this, safeWidth);
    } catch {
      return original.call(this, safeWidth);
    }

    const markdownText = kind === "user" ? extractMarkdownText(this) : undefined;
    const body = trimVisualBlankEdges(markdownText !== undefined ? renderMarkdownText(markdownText, safeWidth - 2) : originalLines);
    const theme = getTheme();
    if (kind === "user") {
      return prefixWrappedLines(body, {
        width: safeWidth,
        initialPrefix: "› ",
        continuationPrefix: "  ",
        theme,
        prefixColor: "dim",
        contentColor: "userMessageText",
        backgroundColor: "userMessageBg",
      });
    }

    return prefixWrappedLines(body, {
      width: safeWidth,
      initialPrefix: "• ",
      continuationPrefix: "  ",
      theme,
      prefixColor: "dim",
      contentColor: undefined,
      backgroundColor: undefined,
    });
  };

  prototype.__codexCompactPatchKind = kind;
  prototype.__codexCompactPatchVersion = PATCH_VERSION;
}

export function patchUserMessagePrototype(
  prototype: PatchableRenderPrototype,
  getTheme: () => CompactThemeLike | undefined,
): void {
  patchPrototype(prototype, "user", getTheme);
}

export function patchAssistantMessagePrototype(
  prototype: PatchableRenderPrototype,
  getTheme: () => CompactThemeLike | undefined,
): void {
  patchPrototype(prototype, "assistant", getTheme);
}
