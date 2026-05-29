import { describe, expect, it, vi } from "vitest";
import petsExtension from "./index.js";

function fakePi(): { on: any; registerCommand: any; registerTool?: any; appendEntry?: any } {
  return {
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
  };
}

describe("pets extension entry point", () => {
  it("registers /pets commands and lifecycle handlers", async () => {
    const pi = fakePi();
    await petsExtension(pi as any);

    const commands = pi.registerCommand.mock.calls.map(([name]: [string]) => name);
    expect(commands).toContain("pets");

    const events = pi.on.mock.calls.map(([name]: [string]) => name);
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });
});
