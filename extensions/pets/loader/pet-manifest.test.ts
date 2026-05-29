import { describe, expect, it } from "vitest";
import { parsePetManifest } from "./pet-manifest.js";

describe("parsePetManifest", () => {
  it("parses a minimal manifest with defaults", () => {
    const manifest = parsePetManifest(
      JSON.stringify({
        id: "default",
        displayName: "Default",
        spritesheetPath: "spritesheet.webp",
        frame: { width: 192, height: 208, columns: 8, rows: 9 },
        animations: {
          idle: { frames: [0] },
        },
      }),
      "/abs/path/to/pet.json",
    );

    expect(manifest.id).toBe("default");
    expect(manifest.frame.width).toBe(192);
    expect(manifest.animations.idle).toEqual({
      frames: [0],
      fps: 4,
      loop: true,
      fallback: "idle",
    });
    expect(manifest.blockArt).toBeUndefined();
  });

  it("parses blockArt overrides", () => {
    const manifest = parsePetManifest(
      JSON.stringify({
        id: "x",
        displayName: "X",
        spritesheetPath: "s.png",
        frame: { width: 8, height: 8, columns: 1, rows: 1 },
        animations: { idle: { frames: [0] } },
        blockArt: { idle: ["a", "b"] },
      }),
      "/abs/path/to/pet.json",
    );

    expect(manifest.blockArt?.idle).toEqual(["a", "b"]);
  });

  it("rejects manifests with missing required fields", () => {
    expect(() => parsePetManifest("{}", "/p/pet.json")).toThrow(/id/);
  });

  it("rejects animations referencing out-of-range frames", () => {
    expect(() =>
      parsePetManifest(
        JSON.stringify({
          id: "x",
          displayName: "X",
          spritesheetPath: "s.png",
          frame: { width: 8, height: 8, columns: 1, rows: 1 },
          animations: { idle: { frames: [5] } },
        }),
        "/p/pet.json",
      ),
    ).toThrow(/frame index/);
  });
});
