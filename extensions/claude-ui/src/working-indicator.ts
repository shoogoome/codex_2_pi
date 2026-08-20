import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * At this size, animating the 80ms working spinner means repeatedly rendering a
 * large transcript just to change one glyph. Keep small sessions animated, but
 * use a static Claude-style dot once full-tree rendering becomes expensive.
 */
export const STATIC_WORKING_INDICATOR_ENTRY_THRESHOLD = 1_000;

export function shouldUseStaticWorkingIndicator(entryCount: number): boolean {
  return entryCount >= STATIC_WORKING_INDICATOR_ENTRY_THRESHOLD;
}

export function applyWorkingIndicatorPerformancePolicy(
  ctx: Pick<ExtensionContext, "sessionManager" | "ui">,
): boolean {
  if (!shouldUseStaticWorkingIndicator(ctx.sessionManager.getBranch().length)) {
    return false;
  }

  // Loader does not start its 80ms interval when it has zero or one frame.
  ctx.ui.setWorkingIndicator({ frames: ["●"] });
  return true;
}
