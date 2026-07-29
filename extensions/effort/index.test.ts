import { describe, expect, it, vi } from "vitest";
import effortExtension from "./index.js";

function createPi(current = "medium") {
  const commands = new Map<string, any>();
  const pi: any = {
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    getThinkingLevel: vi.fn(() => current),
    setThinkingLevel: vi.fn((level: string) => {
      current = level;
    }),
  };
  return { pi, commands };
}

function createCtx() {
  const notifications: Array<{ msg: string; level?: string }> = [];
  const ctx: any = {
    ui: {
      notify: vi.fn((msg: string, level?: string) => {
        notifications.push({ msg, level });
      }),
    },
  };
  return { ctx, notifications };
}

describe("effort extension", () => {
  it("registers the effort command", () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    expect(commands.has("effort")).toBe(true);
  });

  it("shows current level when called without args", async () => {
    const { pi, commands } = createPi("high");
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("", ctx);
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(notifications[0].msg).toContain("high");
  });

  it("sets a valid level", async () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("high", ctx);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notifications[0].msg).toContain("high");
  });

  it("sets pi's native max level", async () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("max", ctx);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(notifications[0].msg).toContain("Effort set to max");
  });

  it("rejects an invalid level", async () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("ultra", ctx);
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(notifications[0].level).toBe("warning");
  });

  it("provides argument completions", () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    expect(commands.get("effort").getArgumentCompletions("hi")).toEqual([
      { value: "high", label: "high" },
    ]);
    expect(commands.get("effort").getArgumentCompletions("ma")).toEqual([
      { value: "max", label: "max" },
    ]);
  });
});
