import { describe, expect, it } from "vitest";
import compactUiExtension from "./index.js";

describe("compactUiExtension", () => {
  it("registers compact built-in tool wrappers", () => {
    const tools: Array<{ name: string }> = [];
    const handlers: Record<string, Function> = {};
    const pi = {
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      on(event: string, handler: Function) {
        handlers[event] = handler;
      },
    };

    compactUiExtension(pi as never);

    expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    expect(handlers.session_start).toBeTypeOf("function");
    expect(handlers.before_agent_start).toBeTypeOf("function");
  });
});
