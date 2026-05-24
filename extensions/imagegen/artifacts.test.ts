import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createImageArtifactPath, saveImageArtifact } from "./artifacts.js";

describe("createImageArtifactPath", () => {
  it("stores generated images under date directories and sanitizes ids", () => {
    const path = createImageArtifactPath("/home/me/.pi", "call/../id", "png", new Date("2026-05-24T12:00:00Z"));

    expect(path).toBe("/home/me/.pi/generated_images/2026-05-24/call____id.png");
  });
});

describe("saveImageArtifact", () => {
  it("writes base64 image data to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-imagegen-"));
    try {
      const saved = await saveImageArtifact({
        agentDir: dir,
        toolCallId: "ig_123",
        base64: Buffer.from("image-bytes").toString("base64"),
        format: "png",
        now: new Date("2026-05-24T12:00:00Z"),
      });

      expect(saved.path).toBe(join(dir, "generated_images", "2026-05-24", "ig_123.png"));
      await expect(readFile(saved.path, "utf8")).resolves.toBe("image-bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
