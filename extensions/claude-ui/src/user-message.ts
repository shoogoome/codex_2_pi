/**
 * Frameless Claude-style user message rendering. Instead of compact-ui's
 * ╭─user─╮ border box, the message is a full-width faint-grey (`userMessageBg`
 * #373737) band with no left padding; a slash command gets a subtle ❯ pointer.
 */
import { GLYPH_POINTER } from "./constants.js";
import {
  isBlankLine,
  sanitizeInlineBackground,
  visibleLength,
} from "./ansi.js";
import type { ClaudeUiTheme } from "./theme-types.js";

const USER_MESSAGE_BG = "userMessageBg";
const BG_RESET = "\x1b[49m";

function applyRowBackground(theme: ClaudeUiTheme | undefined, text: string): string {
  if (!theme) {
    return text;
  }
  try {
    if (typeof theme.getBgAnsi === "function") {
      return `${theme.getBgAnsi(USER_MESSAGE_BG)}${text}${BG_RESET}`;
    }
  } catch {
    // fall through
  }
  try {
    if (typeof theme.bg === "function") {
      return theme.bg(USER_MESSAGE_BG, text);
    }
  } catch {
    // fall through
  }
  return text;
}

function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isBlankLine(lines[start] ?? "")) {
    start++;
  }
  let end = lines.length;
  while (end > start && isBlankLine(lines[end - 1] ?? "")) {
    end--;
  }
  return lines.slice(start, end);
}

/** Drop a single leading space (the native Box paddingX=1) so text hugs the edge. */
function stripSinglePad(text: string): string {
  return text.startsWith(" ") ? text.slice(1) : text;
}

/**
 * Render body lines (already produced by the native renderer, or a plain text
 * body in tests) into the frameless grey band.
 *
 * @param bodyLines raw content lines
 * @param width total terminal width
 * @param theme captured theme (may be undefined before session_start)
 */
export function renderUserMessageLines(
  bodyLines: string[],
  width: number,
  theme: ClaudeUiTheme | undefined,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const content = trimEdgeBlankLines(bodyLines.map(sanitizeInlineBackground));
  if (content.length === 0) {
    return [];
  }

  let firstVisibleSeen = false;
  const rows = content.map((rawLine) => {
    const line = stripSinglePad(rawLine);
    const blank = isBlankLine(line);
    let text = line;

    if (!firstVisibleSeen && !blank) {
      firstVisibleSeen = true;
      const isSlash = stripSinglePad(line).trimStart().startsWith("/");
      if (isSlash) {
        const pointer = theme
          ? theme.fg("dim", `${GLYPH_POINTER} `)
          : `${GLYPH_POINTER} `;
        text = `${pointer}${line.trimStart()}`;
      }
    }

    const pad = " ".repeat(Math.max(0, safeWidth - visibleLength(text)));
    return applyRowBackground(theme, `${text}${pad}`);
  });

  // marginTop=1 keeps the single-blank-line rhythm; the band itself has no top pad.
  return ["", ...rows];
}
