// Background-agent panel — pure render layer.
//
// Visual style mirrors `extensions/teammate/ui/teamWidget.ts` but simpler
// (no team grouping; one flat list of tasks):
//
//   ○ Tasks (5 running)    Ctrl+Y to focus              <- blurred header
//   ● Tasks    ↑/↓ to select · Enter to view            <- focused header
//   ○ local_agent  Fix #2 - default open bash/write   6m 44s  ↓ 74.0k tokens
//   ▶ ○ local_agent  Fix #4 - overlay fills full      6m 10s  ↓ 78.2k tokens   <- selected
//
// Status glyphs:
//   running   → ○ (muted)
//   completed → ● (success)
//   failed    → ✗ (error)
//   killed    → ✗ (error)
//
// Tasks are sorted by startTime ascending so newer-spawned tasks appear at
// the bottom. Width is the budget per row; rows over budget collapse to a
// single truncated line.
//
// `now` is injectable so tests can pin elapsed deterministically;
// production callers leave it undefined and we use Date.now().

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens } from "../format-utils.js";

export interface TaskPanelEntry {
  id: string;
  type: string;
  description: string;
  status: string;
  startTime: number;
  toolCallCount?: number;
  tokenCount?: number;
  /** Most recent tool name (only rendered while status==="running"). */
  lastTool?: string;
}

export interface TaskPanelTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

export interface TaskPanelRenderOptions {
  width?: number;
  selectedTaskId?: string;
  focused?: boolean;
  theme?: TaskPanelTheme;
  now?: number;
}

const PLAIN_THEME: TaskPanelTheme = { fg: (_c, t) => t };
const DEFAULT_WIDTH = 80;
const TITLE = "Tasks";

// `truncate` is a thin shim over Pi TUI's truncateToWidth so call sites
// stay compact. Width math is delegated to truncateToWidth /
// visibleWidth which correctly account for CJK / emoji / ANSI escapes;
// the previous hand-rolled `s.length`-based version silently overran for
// non-ASCII content and tripped Pi's strict per-line width guard
// ("Rendered line N exceeds terminal width").
function truncate(s: string, width: number): string {
  return truncateToWidth(s, width, "…");
}

function statusGlyph(status: string): { glyph: string; color: string } {
  if (status === "running" || status === "pending") {
    return { glyph: "○", color: "muted" };
  }
  if (status === "completed") return { glyph: "●", color: "success" };
  return { glyph: "✗", color: "error" };
}

export function renderTaskPanel(
  tasks: readonly TaskPanelEntry[],
  options: TaskPanelRenderOptions = {},
): string[] {
  if (tasks.length === 0) return [];

  const width = options.width ?? DEFAULT_WIDTH;
  const theme = options.theme ?? PLAIN_THEME;
  const now = options.now ?? Date.now();
  const focused = options.focused;

  const lines: string[] = [];

  // Header — only emitted when focus state is provided. Tests that omit
  // focused get a header-less render (mirrors teammate widget).
  if (focused !== undefined) {
    const runningCount = tasks.filter(
      (t) => t.status === "running" || t.status === "pending",
    ).length;
    const icon = focused ? "●" : "○";
    const headerColor = focused ? "accent" : "dim";
    const hint = focused
      ? "↑/↓ to select · Enter to view"
      : `Ctrl+Y to focus`;
    const countLabel = focused
      ? TITLE
      : `${TITLE} (${runningCount} running)`;
    const plain = `${icon} ${countLabel}    ${hint}`;
    const clipped = truncate(plain, width);
    if (clipped === plain) {
      lines.push(
        `${theme.fg(headerColor, icon)} ${theme.fg(headerColor, countLabel)}    ${theme.fg("dim", hint)}`,
      );
    } else {
      lines.push(theme.fg(headerColor, clipped));
    }
  }

  // Sort tasks by startTime ascending — older tasks bubble to the top.
  const sorted = options.focused
    ? [...tasks.filter((t) => t.status === "running"), ...tasks.filter((t) => t.status !== "running")]
    : [...tasks].sort((a, b) => a.startTime - b.startTime);
  let section = "";
  const grouped = options.focused && tasks.some((t) => t.status !== "running");
  for (const task of sorted) {
    const nextSection = task.status === "running" ? "运行中" : "最近完成（只读）";
    if (grouped && section !== nextSection) { section = nextSection; lines.push(truncate(theme.fg("dim", section), width)); }
    const { glyph, color: glyphColor } = statusGlyph(task.status);
    const isSelected = options.selectedTaskId === task.id;
    const indent = isSelected ? "▶ " : "  ";
    const elapsed = formatDuration(now - task.startTime);
    const tokens = formatTokens(task.tokenCount ?? 0);
    const typeBadge = task.type;
    const bold = theme.bold ?? ((x: string) => x);
    // Only surface lastTool while running — on terminal status the row already
    // says completed/failed/killed; appending "→ bash" would imply still working.
    const showLastTool = task.lastTool && task.status === "running";
    const toolPart = showLastTool ? `  → ${task.lastTool}` : "";

    // Compose plain text first to compute truncation budget without
    // ANSI sequences messing up width math (mirrors teammate widget).
    const plain = `${indent}${glyph}  ${typeBadge}  ${task.description}${toolPart}  ${elapsed}  ↓ ${tokens}`;
    if (visibleWidth(plain) <= width) {
      const prefixSel = isSelected
        ? theme.fg("accent", "▶ ")
        : "  ";
      // Selected row puts agent type in toolTitle bold + accent; description
      // gets accent color. Unselected rows: type in dim toolTitle, description
      // in default text color. Aligns with claudecode tool-call rendering.
      const typeBadgeColored = isSelected
        ? bold(theme.fg("toolTitle", typeBadge))
        : theme.fg("muted", typeBadge);
      const nameColor = isSelected ? "accent" : "text";
      const toolPartColored = showLastTool
        ? `  ${theme.fg("accent", `→ ${task.lastTool}`)}`
        : "";
      lines.push(
        `${prefixSel}${theme.fg(glyphColor, glyph)}  ${typeBadgeColored}  ${theme.fg(nameColor, task.description)}${toolPartColored}  ${theme.fg("dim", elapsed)}  ${theme.fg("dim", `↓ ${tokens}`)}`,
      );
      continue;
    }

    // Width over budget — find the largest truncation of description that
    // still fits with the rest of the row preserved. Rest = indent + glyph
    // + 2 spaces + typeBadge + 2 spaces + (toolPart) + 2 spaces + elapsed
    // + 2 spaces + "↓ " + tokens.
    const fixed = `${indent}${glyph}  ${typeBadge}  ${toolPart}  ${elapsed}  ↓ ${tokens}`;
    const budget = width - visibleWidth(fixed);
    let descShown: string;
    if (budget <= 1) {
      // Not enough room for anything meaningful — fall back to a hard
      // truncate of the whole plain composition.
      lines.push(truncate(plain, width));
      continue;
    }
    descShown = truncate(task.description, budget);
    const final = `${indent}${glyph}  ${typeBadge}  ${descShown}${toolPart}  ${elapsed}  ↓ ${tokens}`;
    lines.push(visibleWidth(final) > width ? truncate(final, width) : final);
  }

  return lines;
}
