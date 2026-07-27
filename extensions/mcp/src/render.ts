/**
 * Frameless, foldable TUI renderers for MCP tools — aligned with claude-ui's
 * built-in tool overrides (and Claude Code's own MCP display):
 *
 *   head:   "● server:tool(args)"  (dot colored by lifecycle state)
 *   result: "  ⎿  <first>"         (continuation lines indent to column 5)
 *
 * Results fold to a few *visual terminal rows* when collapsed, with a
 * "… +K lines (ctrl+o to expand)" hint; pi's global Ctrl+O toggle expands.
 * Everything here is pure/injectable; index.ts wires it into registerTool.
 */
import {
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { keyHint, keyText, rawKeyHint } from "@earendil-works/pi-coding-agent";

/**
 * Narrow structural theme shape (pi's Theme class is compatible). Kept as an
 * interface so helpers stay testable with light fakes.
 */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Tool lifecycle state used to color the head dot (Claude ToolUseLoader). */
export type ToolState = "pending" | "success" | "error";

const GLYPH_DOT = "●";
const GLYPH_ELLIPSIS = "…";
/** First result line prefix: "  ⎿  " (2 spaces + ⎿ + 2 spaces = 5 columns). */
const RESULT_PREFIX = "  ⎿  ";
/** Continuation indent for result lines (5 columns, aligns under content). */
const RESULT_INDENT = "     ";

/** Collapsed cap for normal output (Claude Code MAX_LINES_TO_SHOW = 3). */
export const DEFAULT_MAX_RESULT_LINES = 3;
/** Collapsed cap for error output (Claude Code MAX_RENDERED_LINES = 10). */
export const DEFAULT_MAX_ERROR_LINES = 10;
/** One-line argument summary budget for the tool head. */
export const MAX_ARG_SUMMARY_CHARS = 120;

const DOT_COLOR: Record<ToolState, string> = {
  pending: "dim",
  success: "success",
  error: "error",
};

/** Parse an env value as a strictly-positive integer, else return `fallback`. */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : fallback;
}

/**
 * Resolve the collapsed result cap. `PI_MCP_MAX_RESULT_LINES` wins; the
 * claude-ui knob (`PI_CLAUDE_UI_MAX_RESULT_LINES`) is honored next so users
 * tuning the skin get consistent folding everywhere. Defaults to 3.
 */
export function resolveMaxResultLines(
  env: Record<string, string | undefined> = process.env,
): number {
  const mcp = parsePositiveInt(env.PI_MCP_MAX_RESULT_LINES, -1);
  if (mcp > 0) {
    return mcp;
  }
  return parsePositiveInt(env.PI_CLAUDE_UI_MAX_RESULT_LINES, DEFAULT_MAX_RESULT_LINES);
}

/**
 * Resolve the "expand" hint suffix (e.g. "ctrl+o to expand"), tracking the
 * user's keybinding when available; degrades to a literal string otherwise.
 */
export function resolveExpandHint(): string {
  try {
    const keys = keyText("app.tools.expand");
    if (keys.trim().length > 0) {
      return keyHint("app.tools.expand", "to expand");
    }
    return rawKeyHint("ctrl+o", "to expand");
  } catch {
    return "ctrl+o to expand";
  }
}

/**
 * One-line argument summary for the tool head: compact JSON, capped at
 * `maxChars` with an elision marker. Empty/absent args yield undefined (no
 * parens), matching Claude Code's MCP display.
 */
export function summarizeArgs(
  args: unknown,
  maxChars: number = MAX_ARG_SUMMARY_CHARS,
): string | undefined {
  if (args === undefined || args === null) {
    return undefined;
  }
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (!json || json === "{}" || json === "[]") {
    return undefined;
  }
  const limit = Math.max(1, maxChars);
  return json.length > limit ? `${json.slice(0, limit - 1)}${GLYPH_ELLIPSIS}` : json;
}

/**
 * Single-line tool head, aligned with claude-ui / Claude Code:
 *
 *   ● **server:tool**(arg summary)
 *
 * The dot carries the lifecycle color — dim while pending, green on success,
 * red on error (pi re-invokes renderCall when the result lands, so the color
 * flips in place). The label is bold; the summary sits inside parentheses in
 * the default text color.
 */
export function buildHead(
  label: string,
  argSummary: string | undefined,
  theme: RenderTheme,
  state: ToolState = "pending",
): string {
  const head = `${theme.fg(DOT_COLOR[state], GLYPH_DOT)} ${theme.bold(label)}`;
  const summary = argSummary?.trim();
  return summary ? `${head}(${theme.fg("text", summary)})` : head;
}

/** Extract joined text output + image presence from a tool result content array. */
export function extractResultText(content: unknown): {
  text: string;
  hasImage: boolean;
} {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  const hasImage = blocks.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image",
  );
  return { text, hasImage };
}

/**
 * The dim continuation line shown when output is folded, e.g.
 *   "     … +86 lines (ctrl+o to expand)"
 */
export function buildFoldHint(
  hiddenCount: number,
  theme: RenderTheme,
  expandHint?: string,
): string {
  const hint = expandHint && expandHint.length > 0 ? expandHint : "ctrl+o to expand";
  const label = `${GLYPH_ELLIPSIS} +${hiddenCount} line${hiddenCount === 1 ? "" : "s"}`;
  return `${RESULT_INDENT}${theme.fg("dim", label)} (${hint})`;
}

export interface FoldOptions {
  /** When true, render every row (Ctrl+O expanded state). Default false. */
  expanded?: boolean;
  /** Max visual rows shown when collapsed. Default DEFAULT_MAX_RESULT_LINES. */
  maxLines?: number;
  /** Pre-styled "expand" hint appended after "+K lines". */
  expandHint?: string;
  /** Prefix displayed before a width-truncated single-line summary. */
  overflowMarker?: string;
}

function trimTrailingBlank(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && (next[next.length - 1] ?? "").trim().length === 0) {
    next.pop();
  }
  return next;
}

/**
 * Fold already-styled text by rendered terminal rows instead of logical `\n`
 * lines. This prevents a single huge JSON/log line from wrapping into
 * hundreds of rows before the line cap can see it. Mirrors claude-ui's
 * FoldableText (kept local so this extension stays self-contained).
 */
export class FoldableText implements Component {
  // Memoize the expensive ANSI wrap keyed by the resolved content width; the
  // cheap fold/slice logic runs each frame so `expanded` toggles stay live.
  private cacheWidth = -1;
  private cacheRows: string[] | null = null;

  constructor(
    private readonly text: string,
    private readonly theme: RenderTheme,
    private readonly options: FoldOptions = {},
  ) {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width);
    let rows: string[];
    if (contentWidth === this.cacheWidth && this.cacheRows !== null) {
      rows = this.cacheRows;
    } else {
      rows = this.text ? wrapTextWithAnsi(this.text.replace(/\r/g, ""), contentWidth) : [];
      this.cacheWidth = contentWidth;
      this.cacheRows = rows;
    }
    if (rows.length === 0) {
      return [];
    }

    const {
      expanded = false,
      maxLines = DEFAULT_MAX_RESULT_LINES,
      expandHint,
      overflowMarker,
    } = this.options;
    const limit = Math.max(1, maxLines);
    if (expanded || rows.length <= limit) {
      return rows;
    }

    const hidden = rows.length - limit;
    if (overflowMarker !== undefined && limit === 1) {
      const marker = this.theme.fg("dim", overflowMarker || GLYPH_ELLIPSIS);
      return [truncateToWidth(this.text, contentWidth, marker)];
    }

    // Exactly one overflow row → reveal it instead of a "+1 line" hint
    // (Claude Code terminal.ts: a single extra row is cheaper than elision).
    if (hidden === 1) {
      return rows.slice(0, limit + 1);
    }

    const hint = buildFoldHint(hidden, this.theme, expandHint);
    return [...rows.slice(0, limit), truncateToWidth(hint, contentWidth, GLYPH_ELLIPSIS)];
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.cacheRows = null;
  }
}

/**
 * The tool head component: `● server:tool(args)` truncated to one visual row.
 */
export function renderMcpCall(
  label: string,
  args: unknown,
  theme: RenderTheme,
  state: ToolState,
): Component {
  return new FoldableText(buildHead(label, summarizeArgs(args), theme, state), theme, {
    maxLines: 1,
    overflowMarker: GLYPH_ELLIPSIS,
  });
}

export interface ResultRenderOptions {
  /** pi's global Ctrl+O expand toggle. */
  expanded?: boolean;
  /** Partial (streaming) result — MCP tools don't stream, but stay graceful. */
  isPartial?: boolean;
  /** Error flag from the render context (details.isError is also honored). */
  isError?: boolean;
}

/**
 * The tool result component: `⎿`-prefixed output folded to the collapsed cap
 * (3 rows normal / 10 rows error), expanding fully under Ctrl+O. Errors render
 * in the error color; empty successful output shows dim `(No output)`; image
 * blocks are rendered by pi core itself, so textless image results stay blank.
 */
export function renderMcpResult(
  result: { content?: unknown; details?: unknown },
  options: ResultRenderOptions,
  theme: RenderTheme,
): Component {
  if (options.isPartial) {
    return new Text(theme.fg("dim", "running…"), 0, 0);
  }

  const { text, hasImage } = extractResultText(result?.content);
  const details =
    result?.details && typeof result.details === "object"
      ? (result.details as Record<string, unknown>)
      : {};
  const isError = options.isError === true || details.isError === true;

  if (text.trim().length === 0) {
    if (hasImage) {
      return new Text("", 0, 0);
    }
    return new Text(
      `${theme.fg("dim", RESULT_PREFIX)}${theme.fg("dim", "(No output)")}`,
      0,
      0,
    );
  }

  const rows = trimTrailingBlank(text.replace(/\r/g, "").split("\n"));
  const color = isError ? "error" : "text";
  const styled = rows.map((row, index) =>
    index === 0
      ? `${theme.fg("dim", RESULT_PREFIX)}${theme.fg(color, row)}`
      : `${RESULT_INDENT}${theme.fg(color, row)}`,
  );
  return new FoldableText(styled.join("\n"), theme, {
    expanded: options.expanded === true,
    maxLines: isError ? DEFAULT_MAX_ERROR_LINES : resolveMaxResultLines(),
    expandHint: options.expanded === true ? undefined : resolveExpandHint(),
  });
}
