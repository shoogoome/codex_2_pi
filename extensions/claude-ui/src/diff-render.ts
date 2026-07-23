/**
 * Diff rendering for edit/write results. pi's `EditToolDetails.diff` is NOT a
 * classic unified diff — `generateDiffString` emits per-line records:
 *
 *   "+<n> <content>"   added   (n = new-file line number)
 *   "-<n> <content>"   removed (n = old-file line number)
 *   " <n> <content>"   context
 *   " <pad> ..."       elided context region
 *
 * The Claude look drops the +/- markers and distinguishes rows by a full
 * background color: added #225C2B / removed #7A2936, with a brighter word-level
 * second layer (#38A660 / #B3596B). Context is dim with no background.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  DEFAULT_MAX_DIFF_LINES,
  GLYPH_ELLIPSIS,
  LINE_ADDED,
  LINE_REMOVED,
  RESULT_INDENT,
  RESULT_PREFIX,
  WORD_ADDED,
  WORD_REMOVED,
} from "./constants.js";
import { bgTrueColor, nestedWordBg } from "./bg.js";
import { FoldableText } from "./foldable-text.js";
import { type FoldOptions } from "./tool-gutter.js";
import type { ClaudeUiTheme } from "./theme-types.js";

export type DiffLineKind = "add" | "del" | "context" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  lineNo: string;
  text: string;
}

export interface WordDiff {
  prefix: string;
  delMiddle: string;
  addMiddle: string;
  suffix: string;
}

const NUMBERED_LINE = /^(\s*\d+)\s(.*)$/;

/** Parse pi's edit-diff string into classified line records (marker stripped). */
export function parseEditDiff(diff: string): DiffLine[] {
  if (!diff) {
    return [];
  }
  const out: DiffLine[] = [];
  for (const raw of diff.replace(/\r/g, "").split("\n")) {
    if (raw.length === 0) {
      continue;
    }
    const marker = raw[0];
    const rest = raw.slice(1);
    const kind: DiffLineKind =
      marker === "+" ? "add" : marker === "-" ? "del" : "context";

    if (kind === "context" && rest.trim() === "...") {
      out.push({ kind: "meta", lineNo: "", text: GLYPH_ELLIPSIS });
      continue;
    }

    const match = rest.match(NUMBERED_LINE);
    if (match) {
      out.push({ kind, lineNo: match[1].trim(), text: match[2] });
    } else {
      out.push({ kind, lineNo: "", text: rest });
    }
  }
  return out;
}

/** Char-level common prefix/suffix, leaving the changed middle spans. */
export function computeWordDiff(del: string, add: string): WordDiff {
  const maxPrefix = Math.min(del.length, add.length);
  let prefixLen = 0;
  while (prefixLen < maxPrefix && del[prefixLen] === add[prefixLen]) {
    prefixLen++;
  }
  const maxSuffix = Math.min(del.length, add.length) - prefixLen;
  let suffixLen = 0;
  while (
    suffixLen < maxSuffix &&
    del[del.length - 1 - suffixLen] === add[add.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }
  return {
    prefix: del.slice(0, prefixLen),
    delMiddle: del.slice(prefixLen, del.length - suffixLen),
    addMiddle: add.slice(prefixLen, add.length - suffixLen),
    suffix: del.slice(del.length - suffixLen),
  };
}

function padLineNo(lineNo: string): string {
  return lineNo ? `${lineNo}  ` : "";
}

/**
 * Build the final styled strings (background colors embedded) for a parsed
 * diff. The first row carries the "  ⎿  " connector; the rest indent to
 * column 6. Added/removed rows carry integer backgrounds and never show +/-.
 */
export function buildDiffLineStrings(
  lines: DiffLine[],
  theme: ClaudeUiTheme,
): string[] {
  const out: string[] = [];
  let first = true;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const prefix = first
      ? theme.fg("dim", RESULT_PREFIX)
      : RESULT_INDENT;
    first = false;

    if (line.kind === "meta") {
      out.push(`${prefix}${theme.fg("dim", GLYPH_ELLIPSIS)}`);
      continue;
    }

    if (line.kind === "context") {
      out.push(
        `${prefix}${theme.fg("toolDiffContext", `${padLineNo(line.lineNo)}${line.text}`)}`,
      );
      continue;
    }

    // add / del rows — with optional word-level highlight when paired.
    const paired =
      line.kind === "del" && lines[index + 1]?.kind === "add"
        ? computeWordDiff(line.text, lines[index + 1].text)
        : lines[index - 1]?.kind === "del" && line.kind === "add"
          ? computeWordDiff(lines[index - 1].text, line.text)
          : undefined;

    const lineBg = line.kind === "add" ? LINE_ADDED : LINE_REMOVED;
    const wordBg = line.kind === "add" ? WORD_ADDED : WORD_REMOVED;

    let content: string;
    if (paired) {
      const middle = line.kind === "add" ? paired.addMiddle : paired.delMiddle;
      content = `${paired.prefix}${nestedWordBg(wordBg, lineBg, middle)}${paired.suffix}`;
    } else {
      content = line.text;
    }

    const body = `${padLineNo(line.lineNo)}${content}`;
    out.push(`${prefix}${bgTrueColor(lineBg)(body)}`);
  }

  return out;
}

function linesToComponent(
  strings: string[],
  theme: ClaudeUiTheme,
  fold: FoldOptions,
): Component {
  if (strings.length === 0) {
    return new Text("", 0, 0);
  }
  // Join into one visual-row-aware component so a single minified/code line
  // cannot expand into an unbounded number of terminal rows.
  return new FoldableText(strings.join("\n"), theme, fold);
}

/**
 * Diffs fold at `DEFAULT_MAX_DIFF_LINES` (10, matching Claude's FileWriteTool
 * `MAX_LINES_TO_RENDER`) unless the caller pins an explicit `maxLines` (e.g. the
 * env-resolved value from `resolveMaxLines`).
 */
function withDiffFoldDefault(fold: FoldOptions): FoldOptions {
  return { maxLines: DEFAULT_MAX_DIFF_LINES, ...fold };
}

/** Render an edit result diff. Falls back to dim text when no diff is present. */
export function renderEditDiff(
  diff: string | undefined,
  theme: ClaudeUiTheme,
  fallbackText?: string,
  fold: FoldOptions = {},
): Component {
  const parsed = parseEditDiff(diff ?? "");
  if (parsed.length === 0) {
    const fallback = fallbackText?.trim();
    return new Text(fallback ? theme.fg("dim", fallback) : "", 0, 0);
  }
  const resolvedFold = withDiffFoldDefault(fold);
  return linesToComponent(buildDiffLineStrings(parsed, theme), theme, resolvedFold);
}

/** Turn write content into an all-added diff (no structured diff available). */
export function buildWriteDiffLines(content: string | undefined): DiffLine[] {
  if (!content) {
    return [];
  }
  const lines = content.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((text, index) => ({
    kind: "add" as const,
    lineNo: String(index + 1),
    text,
  }));
}

/** Render a write result as a full-green added block. */
export function renderWriteDiff(
  content: string | undefined,
  theme: ClaudeUiTheme,
  fallbackText?: string,
  fold: FoldOptions = {},
): Component {
  const parsed = buildWriteDiffLines(content);
  if (parsed.length === 0) {
    const fallback = fallbackText?.trim();
    return new Text(fallback ? theme.fg("dim", fallback) : "", 0, 0);
  }
  const resolvedFold = withDiffFoldDefault(fold);
  return linesToComponent(buildDiffLineStrings(parsed, theme), theme, resolvedFold);
}

// Backwards-compatible alias for the planned public name.
export { parseEditDiff as parseUnifiedDiff };
