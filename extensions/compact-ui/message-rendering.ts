import { prefixWrappedLines, trimVisualBlankEdges, type CompactThemeLike } from "./text.js";

export type RenderFn = (width: number) => string[];

export interface PatchableRenderPrototype {
  render: RenderFn;
  __codexCompactOriginalRender?: RenderFn;
  __codexCompactPatchKind?: "user" | "assistant";
  __codexCompactPatchVersion?: number;
}

const PATCH_VERSION = 1;

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

    const body = trimVisualBlankEdges(originalLines);
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
