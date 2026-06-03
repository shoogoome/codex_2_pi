import { describe, it, expect, vi } from "vitest";
import teammateExtension from "./index.js";

describe("teammateExtension entrypoint", () => {
  it("registers session_start and session_shutdown handlers", () => {
    const handlers = new Map<string, unknown>();
    const pi = {
      on: vi.fn((evt: string, handler: unknown) => handlers.set(evt, handler)),
      events: {},
    } as never;
    teammateExtension(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });
});
