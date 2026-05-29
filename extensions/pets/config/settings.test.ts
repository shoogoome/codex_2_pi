import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, loadSettings, saveSettings } from "./settings.js";

describe("pets settings", () => {
  it("returns defaults when no file exists", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-settings-"));
    const settings = await loadSettings(agentDir);
    expect(settings).toEqual(defaultSettings());
  });

  it("round-trips through disk", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-settings-"));
    const expected = { selectedPet: "x", enabled: false, placement: "aboveEditor" as const, tmuxPassthrough: true, renderMode: "block-art" as const };
    await saveSettings(agentDir, expected);
    const onDisk = JSON.parse(readFileSync(join(agentDir, "pets.json"), "utf8"));
    expect(onDisk).toEqual(expected);
    expect(await loadSettings(agentDir)).toEqual(expected);
  });

  it("ignores unknown fields and falls back to defaults for invalid values", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pets-settings-"));
    await saveSettings(agentDir, defaultSettings());
    // Manually overwrite to simulate corruption.
    const filePath = join(agentDir, "pets.json");
    const corrupted = JSON.stringify({ selectedPet: 42, enabled: "yes", placement: "elsewhere", renderMode: "nope", extra: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, corrupted);
    const merged = await loadSettings(agentDir);
    expect(merged).toEqual(defaultSettings());
  });
});
