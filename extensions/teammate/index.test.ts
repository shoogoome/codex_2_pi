import { describe, it, expect, vi } from "vitest";
import teammateExtension from "./index.js";
import { getTeammateHandle } from "./handle.js";

describe("teammateExtension entrypoint", () => {
  it("registers session_start, session_shutdown, and context handlers", () => {
    const handlers = new Map<string, unknown>();
    const pi = {
      on: vi.fn((evt: string, handler: unknown) => handlers.set(evt, handler)),
      events: {},
    } as never;
    teammateExtension(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("context")).toBe(true);
  });

  it("attaches teammate handle (teamStore + mailbox) on pi.events", () => {
    const pi = { on: vi.fn(), events: {} } as never;
    teammateExtension(pi);
    const handle = getTeammateHandle(pi);
    expect(handle.teamStore).toBeDefined();
    expect(handle.mailbox).toBeDefined();
  });

  it("session_shutdown resets stores", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: vi.fn((evt: string, handler: (e: unknown) => unknown) => handlers.set(evt, handler)),
      events: {},
    } as never;
    teammateExtension(pi);
    const { teamStore, mailbox } = getTeammateHandle(pi);
    teamStore.createTeam("t", undefined, 1);
    mailbox.registerReceiver("a", () => {});
    expect(teamStore.list()).toHaveLength(1);
    expect(mailbox.onlineAgents()).toEqual(["a"]);

    const shutdown = handlers.get("session_shutdown")!;
    await shutdown({});

    expect(teamStore.list()).toHaveLength(0);
    expect(mailbox.onlineAgents()).toEqual([]);
  });
});
