/**
 * Wraps `AssistantMessageComponent.prototype.render` to prefix the ● gutter.
 * The theme is captured from `ctx.ui.theme` at session_start (render(width)
 * has no theme argument); before that we degrade to an uncolored dot.
 */
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { applyAssistantGutter } from "./assistant-gutter.js";
import { patchRenderPrototype, type RenderFn } from "./patch.js";
import { ASSISTANT_PATCH_VERSION } from "./constants.js";
import type { ClaudeUiTheme } from "./theme-types.js";

const GUTTER_WIDTH = 2;
const MIN_WIDTH = 4;

export function applyAssistantGutterPatch(
  getTheme: () => ClaudeUiTheme | undefined,
  isEnabled: () => boolean,
): void {
  const prototype = AssistantMessageComponent.prototype as unknown as
    Record<string, unknown> & { render?: RenderFn };

  patchRenderPrototype(
    prototype,
    {
      pristineKey: "__piClaudeUiAssistantOriginalRender",
      patchedKey: "__piClaudeUiAssistantPatched",
      versionKey: "__piClaudeUiAssistantVersion",
      version: ASSISTANT_PATCH_VERSION,
    },
    (originalRender) =>
      function renderWithGutter(this: unknown, width: number): string[] {
        const safeWidth = Math.max(0, Math.floor(width));
        if (!isEnabled() || safeWidth < MIN_WIDTH) {
          return originalRender.call(this, safeWidth);
        }

        // Render into a narrower width so the 2-column gutter does not overflow.
        const lines = originalRender.call(
          this,
          Math.max(1, safeWidth - GUTTER_WIDTH),
        );
        if (lines.length === 0) {
          return lines;
        }

        const theme = getTheme();
        const dotFg = theme
          ? (text: string) => theme.fg("text", text)
          : (text: string) => text;
        return applyAssistantGutter(lines, dotFg);
      },
  );
}
