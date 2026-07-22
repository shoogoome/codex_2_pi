/**
 * Wraps `UserMessageComponent.prototype.render` with the frameless grey band.
 *
 * The pristine base is stored under the SAME key compact-ui uses
 * (`__piUserMessageOriginalRender`) so that whichever extension patches first,
 * both wrap the true native render rather than each other. This extension uses
 * its own patched/version markers, and short-circuits to the original when
 * disabled — so the two never stack (border box + grey band).
 */
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { renderUserMessageLines } from "./user-message.js";
import { patchRenderPrototype, type RenderFn } from "./patch.js";
import { USER_PATCH_VERSION } from "./constants.js";
import type { ClaudeUiTheme } from "./theme-types.js";

const MIN_WIDTH = 8;

export function applyUserMessagePatch(
  getTheme: () => ClaudeUiTheme | undefined,
  isEnabled: () => boolean,
): void {
  const prototype = UserMessageComponent.prototype as unknown as
    Record<string, unknown> & { render?: RenderFn };

  patchRenderPrototype(
    prototype,
    {
      pristineKey: "__piUserMessageOriginalRender",
      patchedKey: "__piClaudeUiUserPatched",
      versionKey: "__piClaudeUiUserVersion",
      version: USER_PATCH_VERSION,
    },
    (originalRender) =>
      function renderWithBand(this: unknown, width: number): string[] {
        const safeWidth = Math.max(0, Math.floor(width));
        if (!isEnabled() || safeWidth < MIN_WIDTH) {
          return originalRender.call(this, safeWidth);
        }

        const bodyLines = originalRender.call(this, safeWidth);
        const rendered = renderUserMessageLines(bodyLines, safeWidth, getTheme());
        return rendered.length > 0 ? rendered : bodyLines;
      },
  );
}
