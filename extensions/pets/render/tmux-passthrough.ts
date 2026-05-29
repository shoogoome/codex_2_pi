const KITTY_SEGMENT = /\x1b_G[^\x1b]*\x1b\\/g;

export function wrapKittyEscapesForTmux(line: string): string {
  return line.replace(KITTY_SEGMENT, (segment) => {
    const escaped = segment.replace(/\x1b/g, "\x1b\x1b");
    return `\x1bPtmux;${escaped}\x1b\\`;
  });
}

export function wrapKittyEscapesInLines(lines: string[]): string[] {
  return lines.map(wrapKittyEscapesForTmux);
}
