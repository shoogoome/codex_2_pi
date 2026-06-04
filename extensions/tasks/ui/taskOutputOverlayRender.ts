// Task-output full-screen overlay — pure render layer.
//
// Renders a task's disk output file as an overlay:
//   - line 0:   header (description, status, elapsed, Esc hint)
//   - line 1:   separator
//   - body:     wrapped output lines, truncated to LAST height-2 entries
//
// The returned string[] is ALWAYS exactly `height` rows (or [] for height
// <= 0) so the overlay paints the full viewport — otherwise Pi's overlay
// only redraws the rows we emit and the leader's main chat would still
// show through underneath (mirrors teammateOverlayRender.ts).

import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TaskPanelEntry } from "./taskPanelRender.js";

export interface TaskOutputOverlayTheme {
  fg(color: string, text: string): string;
}

export interface RenderTaskOutputOverlayOptions {
  theme?: TaskOutputOverlayTheme;
  /** Now timestamp (ms) for elapsed calc; defaults to Date.now(). */
  now?: number;
}

const PLAIN_THEME: TaskOutputOverlayTheme = { fg: (_c, t) => t };
const SEP_CHAR = "─";

function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}

function wrap(line: string, width: number): string[] {
  if (width <= 0) return [line];
  if (visibleWidth(line) <= width) return [line];
  // Use Pi TUI's wrapTextWithAnsi so wrapping respects CJK / emoji /
  // ANSI escapes (graphemes that are 2 cells wide must not be split).
  return wrapTextWithAnsi(line, width);
}

// `truncate` is a thin shim over Pi TUI's truncateToWidth so call sites
// stay compact. Width math is delegated to truncateToWidth /
// visibleWidth which correctly account for CJK / emoji / ANSI escapes;
// the previous hand-rolled `s.length`-based version silently overran for
// non-ASCII content and tripped Pi's strict per-line width guard
// ("Rendered line N exceeds terminal width").
function truncate(s: string, width: number): string {
  return truncateToWidth(s, width, "…");
}

function statusColor(status: string): string {
  if (status === "running" || status === "pending") return "muted";
  if (status === "completed") return "success";
  return "error";
}

function composeHeader(
  task: TaskPanelEntry,
  width: number,
  now: number,
  theme: TaskOutputOverlayTheme,
): string {
  const elapsed = formatElapsed(now - task.startTime);
  const stColor = statusColor(task.status);
  const left = `▶ task: ${task.description} [${task.status}]`;
  const mid = elapsed;
  const right = "Esc to exit";
  const plain = `${left}   ${mid}  ${right}`;
  if (visibleWidth(plain) <= width) {
    const pad = width - visibleWidth(plain);
    const gap = " ".repeat(Math.max(3, pad));
    return `${theme.fg("accent", "▶ task:")} ${theme.fg("text", task.description)} ${theme.fg(stColor, `[${task.status}]`)}${gap}${theme.fg("dim", `${mid}  ${right}`)}`;
  }
  return theme.fg("accent", truncate(plain, width));
}

export function renderTaskOutputOverlay(
  task: TaskPanelEntry,
  outputContent: string,
  width: number,
  height: number,
  options: RenderTaskOutputOverlayOptions = {},
): string[] {
  if (height <= 0) return [];

  const theme = options.theme ?? PLAIN_THEME;
  const now = options.now ?? Date.now();

  const sepLen = Math.max(1, Math.min(width, 200));
  const headerLine = composeHeader(task, width, now, theme);
  const separator = theme.fg("dim", SEP_CHAR.repeat(sepLen));

  const wrapW = Math.max(1, width - 2);
  const rawLines = outputContent === "" ? [] : outputContent.split("\n");
  const bodyLines: string[] = [];
  for (const line of rawLines) {
    for (const w of wrap(line, wrapW)) bodyLines.push(w);
  }
  if (bodyLines.length === 0) bodyLines.push("(no output yet)");

  const bodyBudget = Math.max(0, height - 2);
  const truncated =
    bodyLines.length > bodyBudget
      ? bodyLines.slice(bodyLines.length - bodyBudget)
      : bodyLines;

  const out: string[] = [];
  if (height >= 1) out.push(headerLine);
  if (height >= 2) out.push(separator);
  for (const line of truncated) {
    if (out.length >= height) break;
    if (line === "(no output yet)") {
      out.push(theme.fg("dim", line));
    } else {
      out.push(visibleWidth(line) > width ? truncate(line, width) : line);
    }
  }
  while (out.length < height) out.push("");

  return out;
}
