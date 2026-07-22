/**
 * Small, dependency-free ANSI helpers: strip control sequences, measure
 * visible width, and sanitize inline background SGR so the extension can
 * re-apply its own row backgrounds without residue.
 */

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const OSC_133_PATTERN = /\x1b\]133;[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
/**
 * Contiguous run of zero-width OSC 133 zone markers at the start of a line.
 * A gutter prefix is inserted after these (so the markers stay at the true row
 * start) but before any styling SGR (so the glyph keeps its own color).
 */
export const LEADING_CONTROL_PATTERN =
  /^(?:\x1b\]133;[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\))+/;

const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;

/** Remove all SGR and OSC 133 sequences. */
export function stripControl(text: string): string {
  return text.replace(OSC_133_PATTERN, "").replace(SGR_PATTERN, "");
}

/** True when a line contains no visible characters once control sequences are removed. */
export function isBlankLine(text: string): boolean {
  return stripControl(text).trim().length === 0;
}

/** Visible column count (code points, control sequences excluded). */
export function visibleLength(text: string): number {
  return [...stripControl(text)].length;
}

function toSgrParams(rawParams: string): number[] {
  if (!rawParams.trim()) {
    return [0];
  }
  const parsed = rawParams
    .split(";")
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value));
  return parsed.length > 0 ? parsed : [];
}

function sanitizeSgrParams(params: number[]): number[] {
  const sanitized: number[] = [];
  for (let index = 0; index < params.length; index++) {
    const param = params[index] ?? 0;
    if (param === 0) {
      sanitized.push(...STYLE_RESET_PARAMS);
      continue;
    }
    if (param === 49) {
      continue;
    }
    if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
      continue;
    }
    if (param === 48) {
      const colorMode = params[index + 1];
      if (colorMode === 5) {
        index += 2;
      } else if (colorMode === 2) {
        index += 4;
      }
      continue;
    }
    sanitized.push(param);
  }
  return sanitized;
}

/**
 * Strip OSC 133 prompt markers and any background-color SGR so a themed row
 * background can be applied cleanly without leftover background codes.
 */
export function sanitizeInlineBackground(text: string): string {
  const withoutMarkers = text.replace(OSC_133_PATTERN, "");
  if (!withoutMarkers.includes("\x1b[")) {
    return withoutMarkers;
  }
  return withoutMarkers.replace(SGR_PATTERN, (_sequence, rawParams: string) => {
    const parsed = toSgrParams(rawParams);
    if (parsed.length === 0) {
      return "";
    }
    const sanitized = sanitizeSgrParams(parsed);
    if (sanitized.length === 0) {
      return "";
    }
    return `\x1b[${sanitized.join(";")}m`;
  });
}
