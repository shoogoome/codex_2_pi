import type { Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "../compact-ui/src/diff-renderer.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../compact-ui/src/types.js";
import type { ToolDisplayConfig } from "../compact-ui/src/types.js";

interface MessageRenderOptions {
  expanded: boolean;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
  getFgAnsi?(color: string): string;
  getBgAnsi?(color: string): string;
}

const DIFF_CONFIG: ToolDisplayConfig = {
  ...DEFAULT_TOOL_DISPLAY_CONFIG,
  diffViewMode: "auto",
  diffCollapsedLines: 200,
};

export function renderDiffMessage(
  diffText: string,
  options: MessageRenderOptions,
  theme: RenderTheme,
): Component | undefined {
  if (!diffText.trim()) {
    return undefined;
  }

  return renderEditDiffResult(
    { diff: diffText },
    { expanded: options.expanded },
    DIFF_CONFIG,
    theme,
    diffText,
  );
}
