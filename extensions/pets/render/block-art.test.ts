import { describe, expect, it } from "vitest";
import { renderBlockArt } from "./block-art.js";
import type { RgbaFrame } from "../loader/frames.js";

function frame(width: number, height: number, pixels: number[]): RgbaFrame {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < pixels.length; i++) {
    const offset = i * 4;
    const color = pixels[i];
    rgba[offset + 0] = (color >>> 24) & 0xff;
    rgba[offset + 1] = (color >>> 16) & 0xff;
    rgba[offset + 2] = (color >>> 8) & 0xff;
    rgba[offset + 3] = color & 0xff;
  }
  return { width, height, rgba };
}

describe("renderBlockArt", () => {
  it("returns static blockArt when present, ignoring the spritesheet", () => {
    const lines = renderBlockArt({
      state: "idle",
      animationFrame: frame(2, 2, [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff]),
      blockArt: { idle: ["custom", "lines"] },
      trueColor: true,
    });
    expect(lines).toEqual(["custom", "lines"]);
  });

  it("derives half-block lines from RGBA pixels", () => {
    const lines = renderBlockArt({
      state: "idle",
      animationFrame: frame(2, 2, [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff]),
      blockArt: undefined,
      trueColor: true,
    });
    // 2 pixels wide → 2 cells; 2 pixels tall → 1 row of half-blocks.
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("\u2580"); // ▀
    expect(lines[0]).toContain("\x1b[38;2;255;0;0m");
    expect(lines[0]).toContain("\x1b[48;2;0;0;255m");
  });

  it("emits blanks for fully transparent cells", () => {
    const lines = renderBlockArt({
      state: "idle",
      animationFrame: frame(2, 2, [0, 0, 0, 0]),
      blockArt: undefined,
      trueColor: true,
    });
    expect(lines[0]).toBe("  ");
  });
});
