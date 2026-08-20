import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GLOBAL_SUMMARY_CONFIG_VERSION,
  globalSummarySettingsPath,
  loadGlobalSummaryConfig,
  saveGlobalSummaryConfig,
  validateGlobalSummaryConfig,
} from "./global-config.js";

describe("session summary settings", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), "pi-session-summary-"));
    roots.push(value);
    return value;
  }

  it("returns defaults when settings.json does not exist", async () => {
    const agentDir = await root();
    await expect(loadGlobalSummaryConfig(agentDir)).resolves.toEqual({
      version: GLOBAL_SUMMARY_CONFIG_VERSION,
    });
  });

  it("stores model and display lines in settings.json without dropping other settings", async () => {
    const agentDir = await root();
    const path = globalSummarySettingsPath(agentDir);
    await writeFile(path, `${JSON.stringify({ theme: "dark", env: { EXISTING: "yes" } }, null, 2)}\n`, "utf8");

    await saveGlobalSummaryConfig(agentDir, {
      modelRef: "small/mini",
      visibleRows: 12,
      contextTurns: 4,
    });

    expect(await loadGlobalSummaryConfig(agentDir)).toEqual({
      version: 1,
      modelRef: "small/mini",
      visibleRows: 12,
      contextTurns: 4,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      theme: "dark",
      env: { EXISTING: "yes" },
      sessionSummary: { model: "small/mini", lines: 12, contextTurns: 4 },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("updates one summary setting without clobbering the other", async () => {
    const agentDir = await root();
    const path = globalSummarySettingsPath(agentDir);
    await writeFile(path, JSON.stringify({
      sessionSummary: { model: "small/mini", lines: 6, contextTurns: 3, futureSetting: true },
    }), "utf8");

    await expect(saveGlobalSummaryConfig(agentDir, { visibleRows: 12 })).resolves.toEqual({
      version: 1,
      modelRef: "small/mini",
      visibleRows: 12,
      contextTurns: 3,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      sessionSummary: { model: "small/mini", lines: 12, contextTurns: 3, futureSetting: true },
    });
  });

  it("clears only sessionSummary values and preserves unrelated settings", async () => {
    const agentDir = await root();
    const path = globalSummarySettingsPath(agentDir);
    await writeFile(path, JSON.stringify({
      quietStartup: true,
      sessionSummary: { model: "small/mini", lines: 10, contextTurns: 5 },
    }), "utf8");

    await saveGlobalSummaryConfig(agentDir, { modelRef: null, visibleRows: null, contextTurns: null });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ quietStartup: true });
  });

  it("rejects malformed settings or invalid display lines", async () => {
    expect(() => validateGlobalSummaryConfig({ version: 1, modelRef: 42 })).toThrow("modelRef");
    expect(() => validateGlobalSummaryConfig({ version: 1, visibleRows: 31 })).toThrow("2-30");
    expect(() => validateGlobalSummaryConfig({ version: 1, contextTurns: 21 })).toThrow("0-20");
    const agentDir = await root();
    const path = globalSummarySettingsPath(agentDir);
    await writeFile(path, "{broken", "utf8");
    await expect(loadGlobalSummaryConfig(agentDir)).rejects.toThrow();
    await expect(saveGlobalSummaryConfig(agentDir, { visibleRows: 8 })).rejects.toThrow();
  });
});
