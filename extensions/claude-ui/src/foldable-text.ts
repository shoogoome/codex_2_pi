import {
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { DEFAULT_MAX_RESULT_LINES, GLYPH_ELLIPSIS } from "./constants.js";
import { buildFoldHint, type FoldOptions } from "./tool-gutter.js";
import type { ClaudeUiTheme } from "./theme-types.js";

interface VisualFoldOptions extends FoldOptions {
  /** Number of terminal columns reserved outside this component. */
  widthOffset?: number;
  /** Prefix displayed before a width-truncated single-line summary. */
  overflowMarker?: string;
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
  // Memoize the expensive ANSI wrap (graphemeWidth/wrapSingleLine) keyed by the
  // resolved content width. `text`/`options.widthOffset` are fixed per instance,
  // so for a given width the wrapped rows are deterministic. The TUI re-renders
  // cached components every frame; without this the wrap dominated CPU (100%
  // spin) on large transcripts. The cheap fold/slice logic still runs each frame
  // (so `expanded` toggles stay live).
  private cacheWidth = -1;
  private cacheRows: string[] | null = null;

  constructor(
    private readonly text: string,
    private readonly theme: ClaudeUiTheme,
    private readonly options: VisualFoldOptions = {},
  ) {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - (this.options.widthOffset ?? 0));
    let rows: string[];
    if (contentWidth === this.cacheWidth && this.cacheRows !== null) {
      rows = this.cacheRows;
    } else {
      rows = wrapVisualLines(this.text, contentWidth);
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

    if (hidden === 1) {
      return rows.slice(0, limit + 1);
    }

    const hint = buildFoldHint(hidden, this.theme, expandHint);
    return [
      ...rows.slice(0, limit),
      truncateToWidth(hint, contentWidth, GLYPH_ELLIPSIS),
    ];
  }

  invalidate(): void {
    this.cacheWidth = -1;
    this.cacheRows = null;
  }
}
