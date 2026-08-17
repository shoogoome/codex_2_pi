import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { DEFAULT_MAX_RESULT_LINES, GLYPH_ELLIPSIS } from "./constants.js";
import { BG_RESET } from "./bg.js";
import { buildFoldHint, type FoldOptions } from "./tool-gutter.js";
import type { ClaudeUiTheme } from "./theme-types.js";

interface VisualFoldOptions extends FoldOptions {
  /** Number of terminal columns reserved outside this component. */
  widthOffset?: number;
  /** Prefix displayed before a width-truncated single-line summary. */
  overflowMarker?: string;
  /**
   * Right-pad every emitted row to the full content width. Rows ending in a
   * background reset (diff add/del bars) are padded BEFORE the reset so the
   * background fills the whole terminal row, matching Claude's StructuredDiff
   * full-width bars.
   */
  padRowsToWidth?: boolean;
}

/** Pad one styled row to `width` columns, keeping any trailing bg reset last. */
function padRow(row: string, width: number): string {
  const missing = width - visibleWidth(row);
  if (missing <= 0) {
    return row;
  }
  const padding = " ".repeat(missing);
  return row.endsWith(BG_RESET)
    ? `${row.slice(0, -BG_RESET.length)}${padding}${BG_RESET}`
    : `${row}${padding}`;
}

/** Wrap ANSI text into terminal rows without splitting wide/combined characters. */
export function wrapVisualLines(text: string, width: number): string[] {
  if (!text) {
    return [];
  }
  return wrapTextWithAnsi(text.replace(/\r/g, ""), Math.max(1, width));
}

/**
 * Fold already-styled text by rendered terminal rows instead of logical `\n`
 * lines. This prevents a single huge JSON/base64/log line from wrapping into
 * hundreds of rows before the existing line cap can see it.
 */
export class FoldableText implements Component {
  // Memoize both ANSI wrapping and the final folded/padded output. The TUI
  // re-renders every transcript component on each animation frame; caching only
  // wrapping still left diff rows running padRow -> visibleWidth (Intl.Segmenter)
  // thousands of times per frame in long sessions.
  private cacheWidth = -1;
  private cacheRows: string[] | null = null;
  private renderedCache: {
    contentWidth: number;
    expanded: boolean;
    limit: number;
    expandHint: string | undefined;
    overflowMarker: string | undefined;
    padRowsToWidth: boolean;
    rows: string[];
  } | null = null;

  constructor(
    private readonly text: string,
    private readonly theme: ClaudeUiTheme,
    private readonly options: VisualFoldOptions = {},
  ) {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - (this.options.widthOffset ?? 0));
    const {
      expanded = false,
      maxLines = DEFAULT_MAX_RESULT_LINES,
      expandHint,
      overflowMarker,
      padRowsToWidth = false,
    } = this.options;
    const limit = Math.max(1, maxLines);
    const rendered = this.renderedCache;
    if (
      rendered !== null &&
      rendered.contentWidth === contentWidth &&
      rendered.expanded === expanded &&
      rendered.limit === limit &&
      rendered.expandHint === expandHint &&
      rendered.overflowMarker === overflowMarker &&
      rendered.padRowsToWidth === padRowsToWidth
    ) {
      return rendered.rows;
    }

    let rows: string[];
    if (contentWidth === this.cacheWidth && this.cacheRows !== null) {
      rows = this.cacheRows;
    } else {
      rows = wrapVisualLines(this.text, contentWidth);
      this.cacheWidth = contentWidth;
      this.cacheRows = rows;
    }

    let output: string[];
    if (rows.length === 0) {
      output = [];
    } else if (expanded || rows.length <= limit) {
      output = this.finish(rows, contentWidth);
    } else {
      const hidden = rows.length - limit;
      if (overflowMarker !== undefined && limit === 1) {
        const marker = this.theme.fg("dim", overflowMarker || GLYPH_ELLIPSIS);
        output = [truncateToWidth(this.text, contentWidth, marker)];
      } else if (hidden === 1) {
        output = this.finish(rows.slice(0, limit + 1), contentWidth);
      } else {
        const hint = buildFoldHint(hidden, this.theme, expandHint);
        output = this.finish(
          [...rows.slice(0, limit), truncateToWidth(hint, contentWidth, GLYPH_ELLIPSIS)],
          contentWidth,
        );
      }
    }

    this.renderedCache = {
      contentWidth,
      expanded,
      limit,
      expandHint,
      overflowMarker,
      padRowsToWidth,
      rows: output,
    };
    return output;
  }

  /** Apply the optional full-width padding to the final rows. */
  private finish(rows: string[], contentWidth: number): string[] {
    if (!this.options.padRowsToWidth) {
      return rows;
    }
    return rows.map((row) => padRow(row, contentWidth));
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.cacheRows = null;
    this.renderedCache = null;
  }
}
