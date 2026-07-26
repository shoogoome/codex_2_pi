/**
 * Pure string builders for the frameless tool header and result lines.
 *
 *   head:   "● Name(args)"   (dot colored by state, name bold, args in parens)
 *   result: "  ⎿  <first>"    then continuation lines indent to column 6
 */
import {
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_RESULT_LINES,
  GLYPH_DOT,
  GLYPH_ELLIPSIS,
  RESULT_PREFIX,
  RESULT_INDENT,
} from "./constants.js";
import type { ClaudeUiTheme } from "./theme-types.js";

/** Resolved fold caps for the two result flavors (general output vs. diff). */
export interface ResolvedMaxLines {
  /** Cap for general read/bash/grep/find/ls results + error output. */
  result: number;
  /** Cap for edit/write diff rows. */
  diff: number;
}

/** Parse an env value as a strictly-positive integer, else return `fallback`. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  // Reject anything that isn't a run of digits (no signs, decimals, or junk).
  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : fallback;
}

/**
 * Resolve the collapsed fold caps, letting the user widen them via env when the
 * Claude-aligned defaults (3 general / 10 diff) feel too tight:
 *   - `PI_CLAUDE_UI_MAX_RESULT_LINES` → general/error cap
 *   - `PI_CLAUDE_UI_MAX_DIFF_LINES`   → edit/write diff cap
 * Non-positive / non-integer / missing values fall back to the defaults. Pure:
 * pass an explicit `env` map to unit-test without touching `process.env`.
 */
export function resolveMaxLines(
  env: Record<string, string | undefined> = process.env,
): ResolvedMaxLines {
  return {
    result: parsePositiveInt(env.PI_CLAUDE_UI_MAX_RESULT_LINES, DEFAULT_MAX_RESULT_LINES),
    diff: parsePositiveInt(env.PI_CLAUDE_UI_MAX_DIFF_LINES, DEFAULT_MAX_DIFF_LINES),
  };
}

/** Options controlling how many result/diff lines are shown before eliding. */
export interface FoldOptions {
  /** When true, render every line (Ctrl+O expanded state). Default false. */
  expanded?: boolean;
  /**
   * Max lines shown when collapsed. `foldLines` defaults to
   * `DEFAULT_MAX_RESULT_LINES` (3); the diff renderers default to
   * `DEFAULT_MAX_DIFF_LINES` (10). Callers pass the env-resolved value
   * (`resolveMaxLines`) to override either.
   */
  maxLines?: number;
  /**
   * Pre-styled "expand" hint appended after "+K lines " (e.g. pi's
   * keyHint("app.tools.expand", "to expand") → "ctrl+o to expand"). Falls back
   * to the literal "ctrl+o to expand" when absent.
   */
  expandHint?: string;
}

function trimTrailingBlank(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && (next[next.length - 1] ?? "").trim().length === 0) {
    next.pop();
  }
  return next;
}

/**
 * The dim continuation line shown when output is folded, e.g.
 *   "     … +86 lines (ctrl+o to expand)"
 * Indented to column 6 to align under the connector content.
 */
export function buildFoldHint(
  hiddenCount: number,
  theme: ClaudeUiTheme,
  expandHint?: string,
): string {
  const hint = expandHint && expandHint.length > 0 ? expandHint : "ctrl+o to expand";
  const label = `${GLYPH_ELLIPSIS} +${hiddenCount} line${hiddenCount === 1 ? "" : "s"}`;
  return `${RESULT_INDENT}${theme.fg("dim", label)} (${hint})`;
}

/**
 * Collapse an array of already-styled lines to `maxLines` when not expanded,
 * appending a fold hint that reports how many lines were hidden. When expanded
 * (or already short enough) the lines are returned unchanged.
 *
 * Claude Code detail (`terminal.ts:44-54`): when *exactly one* line would be
 * hidden, show it directly (cap+1 lines) rather than a "… +1 line" hint — a
 * single extra row is cheaper than the elision line it would replace.
 */
export function foldLines(
  lines: string[],
  theme: ClaudeUiTheme,
  options: FoldOptions = {},
): string[] {
  const { expanded = false, maxLines = DEFAULT_MAX_RESULT_LINES } = options;
  const limit = Math.max(1, maxLines);
  if (expanded || lines.length <= limit) {
    return lines;
  }
  const hidden = lines.length - limit;
  // Exactly one overflow line → reveal it instead of a "+1 line" hint.
  if (hidden === 1) {
    return lines.slice(0, limit + 1);
  }
  const shown = lines.slice(0, limit);
  shown.push(buildFoldHint(hidden, theme, options.expandHint));
  return shown;
}

/** Tool lifecycle state used to color the head dot (Claude ToolUseLoader). */
export type ToolState = "pending" | "success" | "error";

const DOT_COLOR: Record<ToolState, string> = {
  pending: "dim",
  success: "success",
  error: "error",
};

/**
 * Single-line tool head, aligned with Claude Code's AssistantToolUseMessage:
 *
 *   ● **Name**(arg summary)
 *
 * The dot carries the lifecycle color — dim while pending, `success` green
 * once resolved, `error` red on failure (pi re-invokes renderCall when the
 * result lands, so the color flips in place). The name is bold; the argument
 * summary sits inside parentheses immediately after it in the default text
 * color (NOT dim). No summary → no parens.
 */
export function buildToolHead(
  name: string,
  argSummary: string | undefined,
  theme: ClaudeUiTheme,
  state: ToolState = "pending",
): string {
  const head = `${theme.fg(DOT_COLOR[state], GLYPH_DOT)} ${theme.bold(name)}`;
  const summary = argSummary?.trim();
  return summary ? `${head}(${theme.fg("text", summary)})` : head;
}

/** A segment of a one-line result summary; `{ bold }` renders bold. */
export type SummarySegment = string | { bold: string };

/**
 * Render summary segments into one styled string (default text color, bold
 * for `{ bold }` segments) — e.g. Claude's `Read **245** lines` /
 * `Added **5** lines, removed **2** lines`.
 */
export function styledSegments(
  theme: ClaudeUiTheme,
  segments: SummarySegment[],
): string {
  return theme.fg(
    "text",
    segments
      .map((segment) =>
        typeof segment === "string" ? segment : theme.bold(segment.bold),
      )
      .join(""),
  );
}

/**
 * Attach the result gutter to an array of pre-styled rows: the first row
 * gets the dim "  ⎿  " connector prefix, the rest indent to column 6.
 */
export function prefixResultRows(rows: string[], theme: ClaudeUiTheme): string[] {
  return rows.map((row, index) =>
    index === 0 ? `${theme.fg("dim", RESULT_PREFIX)}${row}` : `${RESULT_INDENT}${row}`,
  );
}

/**
 * Result lines: the first gets the dim "  ⎿  " connector prefix, the rest
 * indent to column 6. Content keeps the default text color — Claude renders
 * bash stdout un-dimmed (only the ⎿ gutter is dim). Empty output yields an
 * empty array. When collapsed (`!options.expanded`) the output is folded to
 * `maxLines` with a "… +K lines" hint; when expanded, all lines are rendered.
 */
export function buildResultLines(
  text: string,
  theme: ClaudeUiTheme,
  options: FoldOptions = {},
): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }
  const lines = trimTrailingBlank(text.replace(/\r/g, "").split("\n"));
  if (lines.length === 0) {
    return [];
  }
  const styled = prefixResultRows(
    lines.map((line) => theme.fg("text", line)),
    theme,
  );
  return foldLines(styled, theme, options);
}
