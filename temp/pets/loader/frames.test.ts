import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Jimp } from "jimp";
import type { LoadedPet } from "./pet-loader.js";
import { extractFrames } from "./frames.js";

async function writeSpritesheet(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pets-frames-"));
  const image = new Jimp({ width: 4, height: 2, color: 0x00000000 });
  image.setPixelColor(0xff0000ff, 0, 0);
  image.setPixelColor(0x00ff00ff, 2, 0);
  image.setPixelColor(0x0000ffff, 0, 1);
  image.setPixelColor(0xffffffff, 2, 1);
  const path = join(dir, "s.png");
  writeFileSync(path, await image.getBuffer("image/png"));
  return path;
}

describe("extractFrames", () => {
  it("splits a spritesheet into per-frame RGBA buffers using manifest geometry", async () => {
    const path = await writeSpritesheet();
    const pet: LoadedPet = {
      id: "x",
      spritesheetAbsPath: path,
      manifest: {
        id: "x",
        displayName: "X",
        description: "",
        spritesheetPath: "s.png",
        frame: { width: 2, height: 1, columns: 2, rows: 2 },
        animations: { idle: { frames: [0], fps: 4, loop: true, fallback: "idle" } } as any,
        manifestPath: join(path, "..", "pet.json"),
      },
    };

    const frames = await extractFrames(pet);
    expect(frames.length).toBe(4);
    expect(frames[0].width).toBe(2);
    expect(frames[0].height).toBe(1);
    // Frame 0: top-left two pixels of the spritesheet.
    expect(frames[0].rgba[0]).toBe(0xff); // R of (0,0)
    expect(frames[0].rgba[1]).toBe(0x00); // G of (0,0)
    expect(frames[0].rgba[2]).toBe(0x00); // B of (0,0)
    // Frame 1: pixels (2,0) and (3,0).
    expect(frames[1].rgba[0]).toBe(0x00);
    expect(frames[1].rgba[1]).toBe(0xff);
  });
});
