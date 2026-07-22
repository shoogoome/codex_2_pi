import { describe, expect, it } from "vitest";
import compactUiExtension from "./index.js";

interface RegisteredTool {
  name: string;
  renderCall?: Function;
  renderResult?: Function;
}

function createFakePi(flagValues: Record<string, unknown>) {
  const tools: RegisteredTool[] = [];
  const handlers: Record<string, Function[]> = {};
  const flags: Record<string, unknown> = {};

  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    registerFlag(name: string, options: unknown) {
      flags[name] = options;
    },
    getFlag(name: string) {
      return flagValues[name];
    },
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    getAllTools() {
      return [];
    },
  };

  return { pi, tools, handlers, flags };
}

describe("compactUiExtension", () => {
  it("registers its own --compact-ui flag defaulting to true", () => {
    const { pi, flags } = createFakePi({ "claude-ui": false });
    compactUiExtension(pi as never);
    expect(flags["compact-ui"]).toMatchObject({ type: "boolean", default: true });
  });

  it("takes over when claude-ui is disabled: overrides all 7 built-in tools", () => {
    const { pi, tools } = createFakePi({ "claude-ui": false, "compact-ui": true });
    compactUiExtension(pi as never);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("yields to claude-ui when it is enabled: registers no built-in tool overrides", () => {
    const { pi, tools } = createFakePi({ "claude-ui": true });
    compactUiExtension(pi as never);
    expect(tools).toHaveLength(0);
  });

  it("yields when the claude-ui flag is unregistered (undefined = claude-ui default on)", () => {
    const { pi, tools } = createFakePi({});
    compactUiExtension(pi as never);
    expect(tools).toHaveLength(0);
  });

  it("registers lifecycle + thinking event handlers regardless of arbitration", () => {
    const { pi, handlers } = createFakePi({ "claude-ui": true });
    compactUiExtension(pi as never);
    expect(handlers.session_start).toBeDefined();
    expect(handlers.before_agent_start).toBeDefined();
    expect(handlers.message_update).toBeDefined();
    expect(handlers.message_end).toBeDefined();
    expect(handlers.context).toBeDefined();
  });

  it("each registered tool has renderCall and renderResult when active", () => {
    const { pi, tools } = createFakePi({ "claude-ui": false, "compact-ui": true });
    compactUiExtension(pi as never);
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.renderCall, `${tool.name} should have renderCall`).toBeTypeOf("function");
      expect(tool.renderResult, `${tool.name} should have renderResult`).toBeTypeOf("function");
    }
  });
});
