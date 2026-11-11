import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import tmuxTitleExtension from "./index.js";

afterEach(() => vi.unstubAllEnvs());

function setup() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const registerMcpServer = vi.fn();
  const pi = {
    registerMcpServer,
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  };
  tmuxTitleExtension(pi as unknown as ExtensionAPI);
  return { handlers, registerMcpServer };
}

describe("tmux title registration", () => {
  it("registers the packaged stdio server with a pinned pane and direct exposure", () => {
    vi.stubEnv("TMUX", "/tmp/tmux-test,123,0");
    vi.stubEnv("TMUX_PANE", "%7");
    const { handlers, registerMcpServer } = setup();
    expect(registerMcpServer).toHaveBeenCalledWith("tmux_title", expect.objectContaining({
      command: process.execPath,
      env: { TMUX: "/tmp/tmux-test,123,0", TMUX_PANE: "%7" },
      exposure: "direct",
    }));
    expect(existsSync(registerMcpServer.mock.calls[0][1].args[0])).toBe(true);
    // Guidance comes from the directly exposed tool, not per-turn messages or a Skill.
    expect(handlers.size).toBe(0);
  });

  it.each(["", "7", "%7; command"])("does not register without a valid launch pane (%s)", (pane) => {
    vi.stubEnv("TMUX", "/tmp/tmux-test,123,0");
    vi.stubEnv("TMUX_PANE", pane);
    expect(setup().registerMcpServer).not.toHaveBeenCalled();
  });

  it("does not register outside tmux or crash on older hosts", () => {
    vi.stubEnv("TMUX", "");
    vi.stubEnv("TMUX_PANE", "%7");
    expect(setup().registerMcpServer).not.toHaveBeenCalled();
    vi.stubEnv("TMUX", "/tmp/test,123,0");
    expect(() => tmuxTitleExtension({} as ExtensionAPI)).not.toThrow();
  });
});
