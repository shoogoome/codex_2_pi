/**
 * Diff rendering for edit/write results. pi's `EditToolDetails.diff` is NOT a
 * classic unified diff — `generateDiffString` emits per-line records:
 *
 *   "+<n> <content>"   added   (n = new-file line number)
 *   "-<n> <content>"   removed (n = old-file line number)
 *   " <n> <content>"   context
 *   " <pad> ..."       elided context region
 *
 * The Claude look (StructuredDiff/Fallback.tsx) right-aligns line numbers,
 * keeps a +/-/space sigil after them, and distinguishes rows by a FULL-WIDTH
 * background bar: added #225C2B / removed #7A2936, with a brighter word-level
 * second layer (#38A660 / #B3596B). Context is dim with no background. The
 * first result row is the `Added N lines, removed M lines` summary (bold
 * counts), mirroring FileEditToolUpdatedMessage.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  getLanguageFromPath,
  highlightCode,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_DIFF_LINES,
  GLYPH_ELLIPSIS,
  LINE_ADDED,
  LINE_REMOVED,
  WORD_ADDED,
  WORD_REMOVED,
} from "./constants.js";
import { bgTrueColor, nestedWordBg } from "./bg.js";
import { FoldableText } from "./foldable-text.js";
import {
  prefixResultRows,
  styledSegments,
  type FoldOptions,
} from "./tool-gutter.js";
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

const SIGIL: Record<DiffLineKind, string> = {
  add: "+",
  del: "-",
  context: " ",
  meta: " ",
};

/**
 * Gutter prefix for one diff row: line number right-aligned to `numberWidth`,
 * one space, the sigil, one space — e.g. ` 42 + `. Blank for meta rows.
 */
function gutter(line: DiffLine, numberWidth: number): string {
  if (line.kind === "meta") {
    return "";
  }
  const no = line.lineNo.padStart(numberWidth);
  return `${no} ${SIGIL[line.kind]} `;
}

/** Count add/del rows for the `Added N lines, removed M lines` summary. */
export function countDiffChanges(lines: DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") {
      added++;
    } else if (line.kind === "del") {
      removed++;
    }
  }
  return { added, removed };
}

/**
 * Claude FileEditToolUpdatedMessage's first row:
 *   `Added **N** lines, removed **M** lines`
 * (segments omitted when zero; "Removed" capitalized when it leads).
 */
export function buildEditSummary(lines: DiffLine[], theme: ClaudeUiTheme): string {
  const { added, removed } = countDiffChanges(lines);
  const segments: Array<string | { bold: string }> = [];
  if (added > 0) {
    segments.push("Added ", { bold: String(added) }, added === 1 ? " line" : " lines");
  }
  if (added > 0 && removed > 0) {
    segments.push(", ");
  }
  if (removed > 0) {
    segments.push(
      added === 0 ? "Removed " : "removed ",
      { bold: String(removed) },
      removed === 1 ? " line" : " lines",
    );
  }
  return styledSegments(theme, segments);
}

/**
 * Build the final styled strings (background colors embedded) for a parsed
 * diff. Added/removed rows carry full-row backgrounds (padded to terminal
 * width later by FoldableText) and show the +/- sigil after the right-aligned
 * line number; context rows are dim without a background. Rows carry NO ⎿
 * connector/indent — callers compose the result gutter via prefixResultRows
 * so a summary line can take the connector slot.
 */
export function buildDiffLineStrings(
  lines: DiffLine[],
  theme: ClaudeUiTheme,
): string[] {
  const out: string[] = [];
  const numberWidth = lines.reduce(
    (width, line) => Math.max(width, line.lineNo.length),
    0,
  );

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.kind === "meta") {
      out.push(theme.fg("dim", GLYPH_ELLIPSIS));
      continue;
    }

    const head = gutter(line, numberWidth);

    if (line.kind === "context") {
      out.push(theme.fg("toolDiffContext", `${head}${line.text}`));
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

    out.push(bgTrueColor(lineBg)(`${head}${content}`));
  }

  return out;
}

/**
 * Diffs fold at `DEFAULT_MAX_DIFF_LINES` (10, matching Claude's FileWriteTool
 * `MAX_LINES_TO_RENDER`) unless the caller pins an explicit `maxLines` (e.g.
 * the env-resolved value from `resolveMaxLines`). The summary row rides on
 * top of the cap (+1) so it stays visible.
 */
function withDiffFoldDefault(fold: FoldOptions): FoldOptions {
  return { maxLines: DEFAULT_MAX_DIFF_LINES, ...fold };
}

function diffComponent(
  summary: string,
  rows: string[],
  theme: ClaudeUiTheme,
  fold: FoldOptions,
): Component {
  const resolved = withDiffFoldDefault(fold);
  const maxLines = Math.max(1, resolved.maxLines ?? DEFAULT_MAX_DIFF_LINES);
  const all = prefixResultRows([summary, ...rows], theme);
  return new FoldableText(all.join("\n"), theme, {
    ...resolved,
    maxLines: maxLines + 1, // summary row stays visible above the fold
    padRowsToWidth: true,
  });
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
  return diffComponent(
    buildEditSummary(parsed, theme),
    buildDiffLineStrings(parsed, theme),
    theme,
    fold,
  );
}

/**
 * Render a write result the way Claude's FileWriteToolCreatedMessage does:
 *   `Wrote **N** lines to **path**`
 * followed by up to MAX_LINES_TO_RENDER (10) content lines — syntax
 * highlighted when the language is known, plain text otherwise, NO green
 * background (backgrounds are an edit-diff-only device in Claude).
 */
export function renderWriteResult(
  content: string | undefined,
  displayPath: string,
  filePath: string | undefined,
  theme: ClaudeUiTheme,
  fallbackText?: string,
  fold: FoldOptions = {},
): Component {
  if (!content || content.trim().length === 0) {
    const fallback = fallbackText?.trim();
    return new Text(fallback ? theme.fg("dim", fallback) : "", 0, 0);
  }
  const lines = content.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const summary = styledSegments(theme, [
    "Wrote ",
    { bold: String(lines.length) },
    lines.length === 1 ? " line" : " lines",
    " to ",
    { bold: displayPath },
  ]);
  const body = highlightLines(lines, filePath, theme);
  return diffComponent(summary, body, theme, fold);
}

/** Syntax-highlight when the language is known; degrade to plain text. */
function highlightLines(
  lines: string[],
  filePath: string | undefined,
  theme: ClaudeUiTheme,
): string[] {
  if (filePath) {
    try {
      const lang = getLanguageFromPath(filePath);
      if (lang) {
        return highlightCode(lines.join("\n"), lang);
      }
    } catch {
      // fall through to plain text
    }
  }
  return lines.map((line) => theme.fg("text", line));
}

// Backwards-compatible alias for the planned public name.
export { parseEditDiff as parseUnifiedDiff };
