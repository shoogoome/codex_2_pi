import type { RgbaFrame } from "../loader/frames.js";
import type { PetStateName } from "../loader/pet-manifest.js";

const HALF_BLOCK = "\u2580"; // ▀
const ALPHA_VISIBLE_MIN = 32;

export interface RenderBlockArtInput {
  state: PetStateName;
  animationFrame: RgbaFrame;
  blockArt: Partial<Record<PetStateName, string[]>> | undefined;
  trueColor: boolean;
}

export function renderBlockArt(input: RenderBlockArtInput): string[] {
  const staticLines = input.blockArt?.[input.state];
  if (staticLines && staticLines.length > 0) {
    return staticLines.slice();
  }
  return derivePixelLines(input.animationFrame, input.trueColor);
}

function derivePixelLines(frame: RgbaFrame, trueColor: boolean): string[] {
  const lines: string[] = [];
  for (let y = 0; y < frame.height; y += 2) {
    let line = "";
    for (let x = 0; x < frame.width; x++) {
      const top = pixelAt(frame, x, y);
      const bottom = y + 1 < frame.height ? pixelAt(frame, x, y + 1) : transparent();
      line += renderCell(top, bottom, trueColor);
    }
    lines.push(line);
  }
  return lines;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function pixelAt(frame: RgbaFrame, x: number, y: number): Rgba {
  const offset = (y * frame.width + x) * 4;
  return {
    r: frame.rgba[offset + 0],
    g: frame.rgba[offset + 1],
    b: frame.rgba[offset + 2],
    a: frame.rgba[offset + 3],
  };
}

function transparent(): Rgba {
  return { r: 0, g: 0, b: 0, a: 0 };
}

function renderCell(top: Rgba, bottom: Rgba, trueColor: boolean): string {
  const topVisible = top.a >= ALPHA_VISIBLE_MIN;
  const bottomVisible = bottom.a >= ALPHA_VISIBLE_MIN;
  if (!topVisible && !bottomVisible) return " ";

  if (trueColor) {
    const fg = topVisible ? `\x1b[38;2;${top.r};${top.g};${top.b}m` : "\x1b[39m";
    const bg = bottomVisible ? `\x1b[48;2;${bottom.r};${bottom.g};${bottom.b}m` : "\x1b[49m";
    return `${fg}${bg}${HALF_BLOCK}\x1b[0m`;
  }

  // Indexed 256-color fallback: nearest 6×6×6 cube color.
  const fg = topVisible ? `\x1b[38;5;${nearest256(top)}m` : "\x1b[39m";
  const bg = bottomVisible ? `\x1b[48;5;${nearest256(bottom)}m` : "\x1b[49m";
  return `${fg}${bg}${HALF_BLOCK}\x1b[0m`;
}

function nearest256(color: Rgba): number {
  const r = Math.round((color.r / 255) * 5);
  const g = Math.round((color.g / 255) * 5);
  const b = Math.round((color.b / 255) * 5);
  return 16 + 36 * r + 6 * g + b;
}
