import { describe, it, expect } from "vitest";
import { discoverPlugins, discoverPluginAt, probeManifest, detectDirs } from "./discover.js";
import type { FsFacade } from "./discover.js";

/**
 * Build a fake filesystem. `files` maps absolute path → contents; `dirs` is the
 * set of directory paths. readdirSync returns immediate children of a dir.
 */
function makeFakeFs(files: Record<string, string>, dirs: string[]): FsFacade {
  const dirSet = new Set(dirs);
  const fileSet = new Set(Object.keys(files));
  const all = [...dirSet, ...fileSet];
  return {
    existsSync: (p) => dirSet.has(p) || fileSet.has(p),
    isDirectory: (p) => dirSet.has(p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readdirSync: (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const children = new Set<string>();
      for (const entry of all) {
        if (entry.startsWith(prefix)) {
          const rest = entry.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) children.add(first);
        }
      }
      return [...children];
    },
  };
}

describe("probeManifest", () => {
  it("prefers .pi-plugin over .claude-plugin over .cursor-plugin", () => {
    const fs = makeFakeFs(
      {
        "/p/.pi-plugin/plugin.json": '{"name":"pi"}',
        "/p/.claude-plugin/plugin.json": '{"name":"claude"}',
        "/p/.cursor-plugin/plugin.json": '{"name":"cursor"}',
      },
      ["/p", "/p/.pi-plugin", "/p/.claude-plugin", "/p/.cursor-plugin"],
    );
    const r = probeManifest("/p", fs);
    expect(r?.kind).toBe("pi");
    expect(r?.text).toContain("pi");
  });

  it("falls back to .claude-plugin when pi-plugin missing", () => {
    const fs = makeFakeFs(
      { "/p/.claude-plugin/plugin.json": '{"name":"c"}' },
      ["/p", "/p/.claude-plugin"],
    );
    expect(probeManifest("/p", fs)?.kind).toBe("claude");
  });

  it("returns undefined when no manifest present", () => {
    const fs = makeFakeFs({}, ["/p"]);
    expect(probeManifest("/p", fs)).toBeUndefined();
  });
});

describe("detectDirs", () => {
  it("detects convention dirs and files", () => {
    const fs = makeFakeFs(
      { "/p/hooks/hooks.json": "{}", "/p/.mcp.json": "{}" },
      ["/p", "/p/commands", "/p/skills", "/p/themes", "/p/output-styles", "/p/agents", "/p/hooks"],
    );
    const dirs = detectDirs("/p", fs);
    expect(dirs.commands).toBe("/p/commands");
    expect(dirs.skills).toBe("/p/skills");
    expect(dirs.themes).toBe("/p/themes");
    expect(dirs.outputStyles).toBe("/p/output-styles");
    expect(dirs.agents).toBe("/p/agents");
    expect(dirs.hooksJson).toBe("/p/hooks/hooks.json");
    expect(dirs.mcpJson).toBe("/p/.mcp.json");
  });

  it("leaves absent dirs undefined", () => {
    const fs = makeFakeFs({}, ["/p"]);
    const dirs = detectDirs("/p", fs);
    expect(dirs.commands).toBeUndefined();
    expect(dirs.mcpJson).toBeUndefined();
  });
});

describe("discoverPluginAt", () => {
  it("uses manifest name and detects dirs", () => {
    const fs = makeFakeFs(
      { "/root/demo/.claude-plugin/plugin.json": '{"name":"demo-plugin"}' },
      ["/root/demo", "/root/demo/.claude-plugin", "/root/demo/skills"],
    );
    const p = discoverPluginAt("/root/demo", fs);
    expect(p.name).toBe("demo-plugin");
    expect(p.manifestKind).toBe("claude");
    expect(p.dirs.skills).toBe("/root/demo/skills");
  });

  it("falls back to dir name with a minimal manifest when no manifest", () => {
    const fs = makeFakeFs({}, ["/root/bare", "/root/bare/commands"]);
    const p = discoverPluginAt("/root/bare", fs);
    expect(p.name).toBe("bare");
    expect(p.manifestKind).toBe("none");
    expect(p.dirs.commands).toBe("/root/bare/commands");
  });
});

describe("discoverPlugins", () => {
  it("lists one level under each root and ignores non-dir entries", () => {
    const fs = makeFakeFs(
      {
        "/roots/a/.pi-plugin/plugin.json": '{"name":"a"}',
        "/roots/loose.txt": "junk",
        "/roots/b/.claude-plugin/plugin.json": '{"name":"b"}',
      },
      ["/roots", "/roots/a", "/roots/a/.pi-plugin", "/roots/b", "/roots/b/.claude-plugin"],
    );
    const plugins = discoverPlugins(["/roots"], fs);
    expect(plugins.map((p) => p.name).sort()).toEqual(["a", "b"]);
  });

  it("skips missing roots", () => {
    const fs = makeFakeFs({}, ["/exists"]);
    expect(discoverPlugins(["/missing", "/exists"], fs)).toEqual([]);
  });

  it("dedupes by name across roots (first wins)", () => {
    const fs = makeFakeFs(
      {
        "/r1/dup/.pi-plugin/plugin.json": '{"name":"dup","version":"1"}',
        "/r2/dup/.pi-plugin/plugin.json": '{"name":"dup","version":"2"}',
      },
      ["/r1", "/r1/dup", "/r1/dup/.pi-plugin", "/r2", "/r2/dup", "/r2/dup/.pi-plugin"],
    );
    const plugins = discoverPlugins(["/r1", "/r2"], fs);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.manifest.version).toBe("1");
  });
});
