import { describe, expect, it, vi } from "vitest";
import agentsExtension from "./index.js";

vi.mock("./src/loadRoles.js", () => ({
  loadAllRoles: vi.fn(async () => ({
    roles: [{ agentType: "test-role", systemPrompt: "Role instructions", tools: [] }],
    failedFiles: [],
  })),
}));

describe("agents before_agent_start compatibility", () => {
  it.each([
    { type: "before_agent_start", prompt: "legacy prompt" },
    { type: "before_agent_start", messageType: "user", prompt: "1.2 prompt" },
  ])("reserves the one-shot role for a user turn: $prompt", async (userEvent) => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      events: { on: vi.fn() },
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
      getActiveTools: () => ["read"],
      setActiveTools: vi.fn(),
    };
    agentsExtension(pi as never);
    await commands.get("agents")!.handler("use test-role", {
      cwd: "/tmp", hasUI: false, ui: { notify: vi.fn() },
    });
    const before = handlers.get("before_agent_start")!;
    expect(await before({
      type: "before_agent_start", messageType: "custom",
      message: { customType: "background", content: "done", display: false },
    })).toBeUndefined();
    expect(await before(userEvent)).toEqual({ systemPrompt: "Role instructions" });
    expect(await before(userEvent)).toBeUndefined();
  });
});
