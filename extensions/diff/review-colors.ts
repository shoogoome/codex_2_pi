export interface ReviewBackgroundTheme {
  bg?(color: "toolSuccessBg" | "toolErrorBg", text: string): string;
  getBgAnsi?(color: "toolSuccessBg"): string;
  getColorMode?(): "truecolor" | "256color";
}

/** The tool-success slot determines brightness only, never the diff's hue. */
function lightBackground(theme: ReviewBackgroundTheme): boolean {
  const ansi = theme.getBgAnsi?.("toolSuccessBg") ?? theme.bg?.("toolSuccessBg", " ") ?? "";
  const rgb = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(ansi);
  let values: number[];
  if (rgb) values = rgb.slice(1).map(Number);
  else {
    const indexed = /\x1b\[48;5;(\d+)m/.exec(ansi);
    const basic = /\x1b\[(4[0-7]|10[0-7])m/.exec(ansi);
    const code = basic ? Number(basic[1]) : 0;
    const index = indexed ? Number(indexed[1]) : basic ? code < 100 ? code - 40 : code - 100 + 8 : 0;
    if (index >= 232) values = Array(3).fill(8 + (index - 232) * 10);
    else if (index >= 16) {
      const cube = index - 16;
      values = [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6].map((v) => v ? 55 + 40 * v : 0);
    } else {
      const palette = [0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
        0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff];
      const color = palette[index] ?? 0;
      values = [color >> 16, (color >> 8) & 255, color & 255];
    }
  }
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 > 150;
}

/** Explicit Git-style hues, independent of neutral custom tool backgrounds. */
export function reviewRowBackground(theme: ReviewBackgroundTheme, added: boolean, text: string): string {
  const light = lightBackground(theme);
  const color = theme.getColorMode?.() === "truecolor"
    ? `48;2;${light ? added ? "218;251;225" : "255;235;233" : added ? "23;71;43" : "88;39;44"}`
    : `48;5;${light ? added ? 194 : 224 : added ? 22 : 52}`;
  const start = `\x1b[${color}m`;
  // Some custom foreground wrappers use a full reset rather than just SGR 39.
  return start + text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + start) + "\x1b[49m";
}
