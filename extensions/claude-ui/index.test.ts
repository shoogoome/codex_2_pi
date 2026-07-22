import { describe, expect, it, vi } from "vitest";
import activateClaudeUi from "./index.js";
import { CLAUDE_UI_FLAG } from "./src/constants.js";

interface RegisteredTool {
  name: string;
  renderShell?: string;
  parameters: unknown;
  execute: unknown;
}

function createFakeApi() {
  const tools: RegisteredTool[] = [];
  const events: string[] = [];
  const flags: Record<string, { type: string; default?: unknown }> = {};

  const api = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.push(tool);
    }),
    registerFlag: vi.fn((name: string, options: { type: string; default?: unknown }) => {
      flags[name] = options;
    }),
    getFlag: vi.fn((_name: string) => true),
    on: vi.fn((event: string, _handler: unknown) => {
      events.push(event);
    }),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
  };

  return { api, tools, events, flags };
}

describe("claude-ui extension activation", () => {
  it("registers the master flag defaulting to true", () => {
    const { api, flags } = createFakeApi();
    activateClaudeUi(api as never);
    expect(flags[CLAUDE_UI_FLAG]).toMatchObject({ type: "boolean", default: true });
  });

  it("overrides the seven built-in tools with a self render shell", () => {
    const { api, tools } = createFakeApi();
    activateClaudeUi(api as never);
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    for (const tool of tools) {
      expect(tool.renderShell).toBe("self");
      expect(typeof tool.execute).toBe("function");
      expect(tool.parameters).toBeTruthy();
    }
  });

  it("subscribes to session_start and before_agent_start to (re)capture the theme", () => {
    const { api, events } = createFakeApi();
    activateClaudeUi(api as never);
    expect(events).toContain("session_start");
    expect(events).toContain("before_agent_start");
  });
});
