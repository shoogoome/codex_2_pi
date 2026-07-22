/**
 * 24-bit truecolor background helpers. The pi theme has no "diff background"
 * token (only 6 ThemeBg entries, none for diffs), so integer-row diff
 * backgrounds are emitted as raw SGR truecolor escapes.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse "#rrggbb" (or "rrggbb") into an {r,g,b} triple. Invalid input → black. */
export function hexToRgb(hex: string): Rgb {
  const normalized = hex.trim().replace(/^#/, "");
  if (normalized.length !== 6 || /[^0-9a-fA-F]/.test(normalized)) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

/** Raw "set background to hex" SGR (no reset). */
export function bgOpen(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Reset background to terminal default. */
export const BG_RESET = "\x1b[49m";

/**
 * Wrap text in a truecolor background span that resets to the terminal
 * default afterwards.
 */
export function bgTrueColor(hex: string): (text: string) => string {
  const open = bgOpen(hex);
  return (text) => `${open}${text}${BG_RESET}`;
}

/**
 * A word-level background span nested inside a line-level background: switch to
 * `wordHex`, emit `text`, then restore to `lineHex` (NOT the default) so the
 * remainder of the line keeps its row background.
 */
export function nestedWordBg(wordHex: string, lineHex: string, text: string): string {
  if (!text) {
    return "";
  }
  return `${bgOpen(wordHex)}${text}${bgOpen(lineHex)}`;
}
