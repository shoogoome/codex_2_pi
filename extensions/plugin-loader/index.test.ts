import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pluginLoaderExtension from "./index.js";
import { discoverPlugins } from "./src/discover.js";

vi.mock("./src/manager.js", () => ({
  PluginManager: class {
    listInstalled() { return []; }
    isEnabled() { return true; }
  },
}));
vi.mock("./src/discover.js", () => ({
  discoverPlugins: vi.fn(),
  discoverManagedPlugins: () => [],
}));

describe("plugin-loader MCP failure isolation", () => {
  it.each(["startup", "reload"] as const)("keeps other MCP servers and resources available on %s", (reason) => {
    vi.mocked(discoverPlugins).mockReturnValue([{
      name: "demo", root: "/plugins/demo",
      dirs: { skills: "/plugins/demo/skills", themes: "/plugins/demo/themes", agents: "/plugins/demo/agents" },
      manifest: {
        name: "demo", commands: [], agents: [], skills: [], outputStyles: [],
        mcpServers: { paths: [], inline: {
          before: { command: "server" },
          broken: { url: "invalid-url" },
          after: { command: "server" },
        } },
      },
    }]);
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
    const registered: string[] = [];
    const emit = vi.fn();
    const pi = {
      on: (name: string, handler: (event: any, ctx: ExtensionContext) => any) => handlers.set(name, handler),
      registerFlag: vi.fn(), getFlag: vi.fn(), registerCommand: vi.fn(),
      events: { emit },
      registerMcpServer(name: string) {
        if (name === "demo_broken") throw new Error("url must be an http or https URL");
        registered.push(name);
      },
      unregisterMcpServer: vi.fn(),
    };
    pluginLoaderExtension(pi as unknown as ExtensionAPI);
    const notify = vi.fn();
    const ctx = {
      cwd: "/project", ui: { notify }, sessionManager: { getBranch: () => [] },
    } as unknown as ExtensionContext;
    handlers.get("session_start")!({}, ctx);
    expect(registered).toEqual(["demo_before", "demo_after"]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("demo_broken"), "warning");
    expect(emit).toHaveBeenCalledWith("plugins:replace-agents", { paths: ["/plugins/demo/agents"] });
    expect(emit).toHaveBeenCalledWith("plugins:replace-hooks", { hooks: [] });
    registered.length = 0;
    notify.mockClear();
    emit.mockClear();
    const result = handlers.get("resources_discover")!({
      type: "resources_discover", cwd: "/project", reason,
    }, ctx);
    expect(result).toEqual({
      skillPaths: ["/plugins/demo/skills"],
      promptPaths: [],
      themePaths: ["/plugins/demo/themes"],
    });
    if (reason === "reload") {
      expect(registered).toEqual(["demo_before", "demo_after"]);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("demo_broken"), "warning");
      expect(emit).toHaveBeenCalledWith("plugins:replace-agents", { paths: ["/plugins/demo/agents"] });
      expect(emit).toHaveBeenCalledWith("plugins:replace-hooks", { hooks: [] });
    }
  });
});
