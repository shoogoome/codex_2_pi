/**
 * Frameless Claude-style user message rendering. Instead of compact-ui's
 * ╭─user─╮ border box, the message is a full-width faint-grey band with no
 * left padding; a slash command gets a subtle ❯ pointer.
 *
 * Band color is aligned to Claude Code's exact `userMessageBackground`
 * (claude/utils/theme.ts): dark `rgb(55,55,55)` / light `rgb(240,240,240)`,
 * overriding pi's built-in theme values (#343541 / #e8e8e8). Custom pi themes
 * keep their own `userMessageBg` token. Text stays the terminal default
 * foreground in both Claude and pi (no fg override).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH_POINTER } from "./constants.js";
import { bgOpen, BG_RESET } from "./bg.js";
import {
  isBlankLine,
  sanitizeInlineBackground,
} from "./ansi.js";
import type { ClaudeUiTheme } from "./theme-types.js";

const USER_MESSAGE_BG = "userMessageBg";

/** Claude Code `userMessageBackground` per built-in pi theme (claude/utils/theme.ts). */
const CLAUDE_USER_MESSAGE_BG: Record<string, string> = {
  dark: "#373737", // rgb(55,55,55)
  light: "#f0f0f0", // rgb(240,240,240)
};

/** Claude's exact band color for built-in themes; undefined → use the pi theme token. */
function claudeBgAnsi(theme: ClaudeUiTheme): string | undefined {
  const hex = theme.name ? CLAUDE_USER_MESSAGE_BG[theme.name] : undefined;
  return hex ? bgOpen(hex) : undefined;
}

function applyRowBackground(theme: ClaudeUiTheme | undefined, text: string): string {
  if (!theme) {
    return text;
  }
  const claudeAnsi = claudeBgAnsi(theme);
  if (claudeAnsi) {
    return `${claudeAnsi}${text}${BG_RESET}`;
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

    // Native Markdown output can still contain an over-wide physical row for
    // long unbroken mixed ASCII/CJK input. Code-point length is not a terminal
    // column measurement (CJK commonly occupies two columns), and adding the
    // slash-command pointer may consume another two columns. Clamp the final
    // foreground text before padding so the custom band always honours Pi
    // TUI's strict render-width contract.
    const clipped = truncateToWidth(text, safeWidth, "", true);
    const pad = " ".repeat(Math.max(0, safeWidth - visibleWidth(clipped)));
    return applyRowBackground(theme, `${clipped}${pad}`);
  });

  // marginTop=1 keeps the single-blank-line rhythm; the band itself has no top pad.
  return ["", ...rows];
}
