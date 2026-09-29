import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFastModeSettings } from "./settings.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-fast-settings-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { agentDir, cwd };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Fast mode settings", () => {
  it("defaults off when files are absent", () => {
    const { agentDir, cwd } = fixture();
    expect(loadFastModeSettings(agentDir, cwd)).toEqual({ mode: "off", warnings: [] });
  });

  it("loads global JSONC and permits project override including off", () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(join(agentDir, "settings.json"), '{ // comment\n "fastMode": "fast", }');
    expect(loadFastModeSettings(agentDir, cwd).mode).toBe("fast");
    writeFileSync(join(cwd, ".pi", "settings.json"), '{"fastMode":"ultrafast"}');
    expect(loadFastModeSettings(agentDir, cwd).mode).toBe("ultrafast");
    writeFileSync(join(cwd, ".pi", "settings.json"), '{"fastMode":"off"}');
    expect(loadFastModeSettings(agentDir, cwd).mode).toBe("off");
  });

  it("retains global mode if project settings omit the key or are invalid", () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(join(agentDir, "settings.json"), '{"fastMode":"fast"}');
    writeFileSync(join(cwd, ".pi", "settings.json"), '{"theme":"dark"}');
    expect(loadFastModeSettings(agentDir, cwd)).toEqual({ mode: "fast", warnings: [] });
    for (const content of ['{"fastMode":true}', '{"fastMode":"bad"}', '{bad-json']) {
      writeFileSync(join(cwd, ".pi", "settings.json"), content);
      const result = loadFastModeSettings(agentDir, cwd);
      expect(result.mode).toBe("fast");
      expect(result.warnings).toHaveLength(1);
    }
  });
});
