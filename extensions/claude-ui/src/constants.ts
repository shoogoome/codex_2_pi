/**
 * Glyphs, colors, spacing, and patch version constants for the Claude Code
 * style TUI. Pure constants only — no runtime imports.
 */

/** Assistant message leading dot (● U+25CF). */
export const GLYPH_DOT = "●";
/** Tool result tree connector (⎿ U+23BF). */
export const GLYPH_CONNECTOR = "⎿";
/** Slash-command pointer (❯ U+276F). */
export const GLYPH_POINTER = "❯";
/** Elision marker used for diff skip regions. */
export const GLYPH_ELLIPSIS = "…";

/** First result line prefix: "  ⎿  " (2 spaces + ⎿ + 2 spaces = 5 columns). */
export const RESULT_PREFIX = `  ${GLYPH_CONNECTOR}  `;
/** Continuation indent for result / diff lines (5 columns, aligns under content). */
export const RESULT_INDENT = "     ";
/** Assistant hanging indent for wrapped lines (2 columns, aligns under the dot gutter). */
export const HANGING_INDENT = "  ";

/**
 * Default number of lines shown when a general tool result (read/bash/grep/
 * find/ls) or an error output is collapsed (i.e. `!expanded`). Overflow is
 * elided behind a "… +K lines (ctrl+o to expand)" hint; Ctrl+O toggles
 * `expanded` to reveal everything.
 *
 * Aligned to Claude Code's `MAX_LINES_TO_SHOW = 3` in
 * `claude/utils/terminal.ts` (`renderTruncatedContent`).
 *
 * Overridable at runtime via the `PI_CLAUDE_UI_MAX_RESULT_LINES` env var
 * (positive integer); see `resolveMaxLines` in `tool-gutter.ts`.
 */
export const DEFAULT_MAX_RESULT_LINES = 3;

/**
 * Default number of lines shown when an edit/write diff is collapsed. Diffs are
 * more valuable to see in full than raw command output, so they fold later.
 *
 * Aligned to Claude Code's `MAX_LINES_TO_RENDER = 10` in
 * `claude/tools/FileWriteTool/UI.tsx`.
 *
 * Overridable at runtime via the `PI_CLAUDE_UI_MAX_DIFF_LINES` env var
 * (positive integer); see `resolveMaxLines` in `tool-gutter.ts`.
 */
export const DEFAULT_MAX_DIFF_LINES = 10;

/** diff — full-row background for added lines. */
export const LINE_ADDED = "#225C2B";
/** diff — full-row background for removed lines. */
export const LINE_REMOVED = "#7A2936";
/** diff — brighter word-level background for added spans. */
export const WORD_ADDED = "#38A660";
/** diff — brighter word-level background for removed spans. */
export const WORD_REMOVED = "#B3596B";

/** Prototype patch versions — bump to force re-wrap after a code change. */
export const ASSISTANT_PATCH_VERSION = 1;
export const USER_PATCH_VERSION = 1;

/** CLI flag name that toggles the whole extension. */
export const CLAUDE_UI_FLAG = "claude-ui";
