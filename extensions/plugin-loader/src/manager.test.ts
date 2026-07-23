import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  PluginManager,
  normalizeScope,
  parseMarketplaceManifest,
  readState,
  statePath,
} from "./manager.js";

function fixture(): { root: string; cwd: string; home: string; market: string } {
  const root = mkdtempSync(join(tmpdir(), "plugin-manager-test-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const market = join(root, "market");
  const plugin = join(market, "plugins", "demo");
  mkdirSync(join(market, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "commands"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "1.2.3" }));
  writeFileSync(join(plugin, "commands", "hello.md"), "---\ndescription: hi\n---\nhello");
  writeFileSync(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "test-market",
    plugins: [{ name: "demo", version: "1.2.3", description: "Demo", source: "./plugins/demo" }],
  }));
  return { root, cwd, home, market };
}

describe("plugin manager state", () => {
  it("validates scopes and maps scope paths", () => {
    expect(normalizeScope("project")).toBe("project");
    expect(() => normalizeScope("global")).toThrow(/Invalid scope/);
    expect(statePath("user", "/work", "/home/a")).toBe("/home/a/.pi/agent/plugins/state.json");
    expect(statePath("local", "/work", "/home/a")).toBe("/work/.pi/plugins.local.json");
  });

  it("returns an empty state when absent", () => {
    expect(readState("/definitely/missing/pi-plugin-state.json").installed).toEqual({});
  });

  it("validates marketplace manifests", () => {
    expect(parseMarketplaceManifest({ name: "x", plugins: [{ name: "p", source: "./p" }] }).name).toBe("x");
    expect(() => parseMarketplaceManifest({ name: "../x", plugins: [] })).toThrow(/Invalid marketplace/);
    expect(() => parseMarketplaceManifest({ name: "x", plugins: [{ name: "p" }] })).toThrow(/requires a string source/);
  });
});

describe("PluginManager local marketplace flow", () => {
  it("adds, installs, configures, toggles, details, updates, uninstalls and removes", () => {
    const f = fixture();
    const manager = new PluginManager({ cwd: f.cwd, home: f.home, now: () => new Date("2026-01-01T00:00:00.000Z") });

    const market = manager.addMarketplace(f.market, "project");
    expect(market.name).toBe("test-market");
    expect(manager.listAvailable()).toMatchObject([{ id: "demo@test-market", installed: false }]);

    const installed = manager.install("demo@test-market", "local");
    expect(installed.at(-1)?.version).toBe("1.2.3");
    expect(existsSync(installed.at(-1)!.path)).toBe(true);
    expect(manager.listAvailable()[0]?.installed).toBe(true);

    expect(manager.setEnabled("demo", false).scope).toBe("local");
    expect(manager.isEnabled("demo")).toBe(false);
    expect(manager.configure("demo", { token: "x" }).userConfig).toEqual({ token: "x" });
    expect(manager.details("demo").components.commands).toBe(1);
    expect(manager.pluginEnvironment(installed.at(-1)!)).toMatchObject({ CLAUDE_PLUGIN_ROOT: installed.at(-1)!.path });

    expect(manager.update("demo", "local").at(-1)?.name).toBe("demo");
    expect(manager.uninstall("demo", "local").name).toBe("demo");
    expect(manager.removeMarketplace("test-market", "project")).toBe(1);
  });

  it("validates and scaffolds plugins", () => {
    const f = fixture();
    const manager = new PluginManager({ cwd: f.cwd, home: f.home });
    expect(manager.validate(join(f.market, "plugins", "demo"))).toMatchObject({ valid: true, kind: "plugin" });
    expect(manager.validate(f.market)).toMatchObject({ valid: true, kind: "marketplace" });
    const path = manager.init("new-plugin", join(f.root, "scaffold"));
    expect(JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("new-plugin");
  });

  it("rejects marketplace source traversal", () => {
    const f = fixture();
    writeFileSync(join(f.market, ".claude-plugin", "marketplace.json"), JSON.stringify({
      name: "test-market",
      plugins: [{ name: "demo", source: "../outside" }],
    }));
    const manager = new PluginManager({ cwd: f.cwd, home: f.home });
    expect(manager.validate(f.market).valid).toBe(false);
    manager.addMarketplace(f.market, "user");
    expect(() => manager.install("demo@test-market", "user")).toThrow(/escapes marketplace|does not exist/);
  });
});
