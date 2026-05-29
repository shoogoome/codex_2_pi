import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPet } from "./pet-loader.js";

function writeTmpPet(id: string, manifest: object): { agentDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), "pets-loader-"));
  const petDir = join(agentDir, "pets", id);
  mkdirSync(petDir, { recursive: true });
  writeFileSync(join(petDir, "pet.json"), JSON.stringify(manifest));
  return { agentDir };
}

describe("loadPet", () => {
  it("loads the bundled default pet", () => {
    const result = loadPet("default", { agentDir: "/nonexistent" });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pet.id).toBe("default");
      expect(result.pet.spritesheetAbsPath).toMatch(/spritesheet\.png$/);
    }
  });

  it("loads a user-installed pet from <agentDir>/pets/<id>/pet.json", () => {
    const { agentDir } = writeTmpPet("cat", {
      id: "cat",
      displayName: "Cat",
      spritesheetPath: "sprite.png",
      frame: { width: 8, height: 8, columns: 1, rows: 1 },
      animations: { idle: { frames: [0] } },
    });
    writeFileSync(join(agentDir, "pets", "cat", "sprite.png"), Buffer.alloc(0));

    const result = loadPet("cat", { agentDir });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.pet.id).toBe("cat");
      expect(result.pet.spritesheetAbsPath.endsWith("sprite.png")).toBe(true);
    }
  });

  it("falls back to default with a reason when the id is unknown", () => {
    const result = loadPet("does-not-exist", { agentDir: "/nonexistent" });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.pet.id).toBe("default");
      expect(result.reason).toMatch(/does-not-exist/);
    }
  });

  it("falls back to default when the user manifest fails to parse", () => {
    const { agentDir } = writeTmpPet("broken", {});
    const result = loadPet("broken", { agentDir });
    expect(result.kind).toBe("fallback");
    if (result.kind === "fallback") {
      expect(result.pet.id).toBe("default");
      expect(result.reason).toMatch(/broken/);
    }
  });
});
