import { describe, expect, it, vi } from "vitest";
import sideExtension from "./index.js";

function createFakePi() {
  const commands = new Map<string, any>();
  return {
    commands,
    pi: {
      registerCommand: vi.fn((name: string, options: any) => commands.set(name, options)),
      on: vi.fn(),
    } as any,
  };
}

describe("side extension", () => {
  it("registers /side", () => {
    const { pi, commands } = createFakePi();

    sideExtension(pi);

    expect(commands.has("side")).toBe(true);
    expect(commands.get("side").description).toContain("side conversation");
  });

  it("requires interactive UI", async () => {
    const { pi, commands } = createFakePi();
    sideExtension(pi);
    const notify = vi.fn();

    await commands.get("side").handler("hello", { hasUI: false, ui: { notify }, cwd: "/repo" });

    expect(notify).toHaveBeenCalledWith("/side requires interactive mode", "error");
  });

  it("requires an active model", async () => {
    const { pi, commands } = createFakePi();
    sideExtension(pi);
    const notify = vi.fn();

    await commands.get("side").handler("hello", { hasUI: true, model: undefined, ui: { notify }, cwd: "/repo" });

    expect(notify).toHaveBeenCalledWith("/side requires an active model", "error");
  });
});
