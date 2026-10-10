import { describe, expect, it, vi } from "vitest";
import openSpecProgressExtension from "./index.js";

function makePi(shortcut: string | undefined = undefined) {
  const flags = new Map<string, unknown>();
  const handlers = new Map<string, unknown[]>();
  const pi: any = {
    registerFlag: vi.fn((name: string, definition: { default?: unknown }) => {
      flags.set(name, shortcut === undefined ? definition.default : shortcut);
    }),
    getFlag: vi.fn((name: string) => flags.get(name)),
    registerShortcut: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    on: vi.fn((name: string, handler: unknown) => {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    }),
  };
  return { pi, handlers };
}

describe("openspec progress extension", () => {
  it("registers Alt+O by default", () => {
    const { pi } = makePi();
    openSpecProgressExtension(pi);
    expect(pi.registerShortcut).toHaveBeenCalledWith("alt+o", expect.any(Object));
    expect(pi.registerShortcut).toHaveBeenCalledWith("alt+enter", expect.any(Object));
  });

  it("allows disabling the shortcut with an empty flag", () => {
    const { pi } = makePi("");
    openSpecProgressExtension(pi);
    expect(pi.registerShortcut).not.toHaveBeenCalledWith("alt+o", expect.any(Object));
    expect(pi.registerShortcut).toHaveBeenCalledWith("alt+enter", expect.any(Object));
  });
});
