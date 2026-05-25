import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SGR_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
const OSC_133_PATTERN = /\x1b\]133;[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;

export interface CompactThemeLike {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold?(text: string): string;
}

export interface PrefixWrappedLinesOptions {
  width: number;
  initialPrefix: string;
  continuationPrefix: string;
  theme?: CompactThemeLike;
  prefixColor?: string;
  contentColor?: string;
  backgroundColor?: string;
}

function stripVisualControlSequences(text: string): string {
  return text.replace(OSC_133_PATTERN, "").replace(SGR_ESCAPE_PATTERN, "");
}

function isVisualBlank(line: string): boolean {
  return stripVisualControlSequences(line).trim().length === 0;
}

export function trimVisualBlankEdges(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isVisualBlank(lines[start] ?? "")) start++;

  let end = lines.length;
  while (end > start && isVisualBlank(lines[end - 1] ?? "")) end--;

  return lines.slice(start, end);
}

function color(theme: CompactThemeLike | undefined, colorName: string | undefined, text: string): string {
  if (!theme || !colorName || text.length === 0) return text;
  try {
    return theme.fg(colorName, text);
  } catch {
    return text;
  }
}

function background(theme: CompactThemeLike | undefined, colorName: string | undefined, text: string): string {
  if (!theme || !colorName || text.length === 0) return text;
  try {
    return theme.bg ? theme.bg(colorName, text) : text;
  } catch {
    return text;
  }
}

function padToWidth(text: string, width: number): string {
  const visual = visibleWidth(text);
  return `${text}${" ".repeat(Math.max(0, width - visual))}`;
}

export function prefixWrappedLines(lines: string[], options: PrefixWrappedLinesOptions): string[] {
  const safeWidth = Math.max(1, Math.floor(options.width));
  const body = lines.length > 0 ? lines : [""];

  return body.map((line, index) => {
    const rawPrefix = index === 0 ? options.initialPrefix : options.continuationPrefix;
    const prefix = color(options.theme, options.prefixColor, options.theme?.bold ? options.theme.bold(rawPrefix) : rawPrefix);
    const prefixWidth = visibleWidth(rawPrefix);
    const contentWidth = Math.max(1, safeWidth - prefixWidth);
    const clipped = truncateToWidth(line, contentWidth, "", true);
    const styledContent = color(options.theme, options.contentColor, clipped);
    const padded = `${prefix}${styledContent}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))}`;
    return background(options.theme, options.backgroundColor, padToWidth(padded, safeWidth));
  });
}
