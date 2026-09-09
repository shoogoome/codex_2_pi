// extensions/token-speed/src/panel.ts
//
// /speed panel component (render layer). Rendered as a toggleable widget above
// the editor via ctx.ui.setWidget (component-factory form). The component is
// NOT focused, so it needs no keyboard handling — /speed toggles it, and
// index.ts re-sets the widget on data events so the numbers stay live.

import { truncateToWidth } from "@earendil-works/pi-tui";
import { buildPanelLines, type PanelInput, type PanelTheme } from "./format.js";

export interface TokenSpeedPanelComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export interface BuildPanelOptions {
  getInput: () => PanelInput;
  theme?: PanelTheme;
}

export function buildTokenSpeedPanelComponent(opts: BuildPanelOptions): TokenSpeedPanelComponent {
  function render(width: number): string[] {
    const w = Math.max(20, Math.floor(Number.isFinite(width) ? width : 80));
    return buildPanelLines(opts.getInput(), opts.theme).map((line) => truncateToWidth(line, w, "…"));
  }

  return {
    render,
    invalidate() {
      /* recomputed each render; nothing cached */
    },
  };
}
