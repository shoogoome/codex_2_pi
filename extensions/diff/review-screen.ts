import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";

export const REVIEW_OVERLAY_OPTIONS = {
  width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0,
} satisfies OverlayOptions;

/**
 * A regular-mode overlay alone still moves whenever its underlying document grows:
 * pi-tui composites it onto the last terminal-height rows of that document.
 * Temporarily unmount the transcript roots, without stopping their model updates.
 * Fullscreen mode already composites over a fixed-height viewport.
 * Use only public Container APIs; never pause the renderer or intercept model events.
 */
export function suspendReviewBackground(tui: TUI): () => void {
  if (tui.mode !== "regular") return () => {};
  const roots = tui.children;
  const placeholder: Component = {
    render: () => [],
    invalidate: () => { for (const root of roots) root.invalidate?.(); },
  };
  const mounted = [placeholder];
  tui.children = mounted;
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const index = tui.children.indexOf(placeholder);
    // Do not resurrect an old tree if another UI/session already replaced it.
    if (index < 0) return;
    if (tui.children === mounted && mounted.length === 1) tui.children = roots;
    else tui.children.splice(index, 1, ...roots);
    tui.requestRender();
  };
}
