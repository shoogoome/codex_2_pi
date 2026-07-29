// extensions/cost-usage/src/panel.ts
//
// /cost panel component (render layer). Rendered as a toggleable widget above
// the editor via ctx.ui.setWidget (component-factory form). Returns a pi-tui
// Component whose render(width) produces width-truncated lines. Read-only;
// derives everything from the snapshot via the pure buildOverviewLines(). The
// widget is NOT focused, so it needs no keyboard handling — /cost toggles it.

import { truncateToWidth } from "@earendil-works/pi-tui";
import type { CodexSubscriptionState } from "./codex-subscription.js";
import { buildOverviewLines, type OverviewTheme } from "./format.js";
import type { CostSnapshot } from "./types.js";

export interface CostPanelComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export interface BuildPanelOptions {
  getSnapshot: () => CostSnapshot | null;
  getCodexSubscription?: () => CodexSubscriptionState;
  theme?: OverviewTheme;
}

export function buildCostPanelComponent(opts: BuildPanelOptions): CostPanelComponent {
  function render(width: number): string[] {
    const w = Math.max(20, Math.floor(Number.isFinite(width) ? width : 80));
    const snap = opts.getSnapshot();
    return buildOverviewLines(snap, {
      theme: opts.theme,
      codexSubscription: opts.getCodexSubscription?.(),
    }).map((line) => truncateToWidth(line, w, "…"));
  }

  return {
    render,
    invalidate() {
      /* recomputed each render; nothing cached */
    },
  };
}
