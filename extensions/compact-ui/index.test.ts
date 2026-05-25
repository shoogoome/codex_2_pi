import { describe, expect, it } from "vitest";
import compactUiExtension from "./index.js";

describe("compactUiExtension", () => {
  it("registers compact built-in tool wrappers and event handlers", () => {
    const tools: Array<{ name: string }> = [];
    const handlers: Record<string, Function[]> = {};
    const pi = {
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      on(event: string, handler: Function) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      },
      getAllTools() {
        return [];
      },
    };

    compactUiExtension(pi as never);

    // Should register overrides for all 7 built-in tools
    expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);

    // Should register event handlers for session lifecycle and thinking
    expect(handlers.session_start).toBeDefined();
    expect(handlers.before_agent_start).toBeDefined();
    expect(handlers.message_update).toBeDefined();
    expect(handlers.message_end).toBeDefined();
    expect(handlers.context).toBeDefined();
  });

  it("each registered tool has renderCall and renderResult methods", () => {
    const tools: Array<{ name: string; renderCall?: Function; renderResult?: Function }> = [];
    const pi = {
      registerTool(tool: { name: string; renderCall?: Function; renderResult?: Function }) {
        tools.push(tool);
      },
      on() {},
      getAllTools() { return []; },
    };

    compactUiExtension(pi as never);

    for (const tool of tools) {
      expect(tool.renderCall, `${tool.name} should have renderCall`).toBeTypeOf("function");
      expect(tool.renderResult, `${tool.name} should have renderResult`).toBeTypeOf("function");
    }
  });
});
