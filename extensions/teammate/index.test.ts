import { describe, it, expect, vi } from "vitest";
import teammateExtension from "./index.js";
import { getTeammateHandle } from "./handle.js";

function buildFakeTasksHandle(): {
  handle: {
    store: { get: () => Record<string, unknown>; getTask: () => undefined };
    registerTaskType: ReturnType<typeof vi.fn>;
    getTaskType: ReturnType<typeof vi.fn>;
    unregisterTaskType: ReturnType<typeof vi.fn>;
  };
} {
  return {
    handle: {
      store: { get: () => ({}), getTask: () => undefined },
      registerTaskType: vi.fn(),
      getTaskType: vi.fn(),
      unregisterTaskType: vi.fn(),
    },
  };
}

function buildFakePi(): {
  pi: {
    on: ReturnType<typeof vi.fn>;
    events: Record<string, unknown>;
    registerTool: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
  handlers: Map<string, (event: unknown) => unknown>;
  tasksHandle: ReturnType<typeof buildFakeTasksHandle>["handle"];
} {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const { handle: tasksHandle } = buildFakeTasksHandle();
  const pi = {
    on: vi.fn((evt: string, h: (e: unknown) => unknown) =>
      handlers.set(evt, h),
    ),
    events: { __pi_tasks_handle__: tasksHandle } as Record<string, unknown>,
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi, handlers, tasksHandle };
}

describe("teammateExtension entrypoint", () => {
  it("registers session_start, session_shutdown, and context handlers", () => {
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("context")).toBe(true);
  });

  it("attaches teammate handle (teamStore + mailbox) on pi.events", () => {
    const { pi } = buildFakePi();
    teammateExtension(pi as never);
    const handle = getTeammateHandle(pi as never);
    expect(handle.teamStore).toBeDefined();
    expect(handle.mailbox).toBeDefined();
  });

  it("session_start registers in_process_teammate task type", async () => {
    const { pi, handlers, tasksHandle } = buildFakePi();
    teammateExtension(pi as never);
    const start = handlers.get("session_start")!;
    await start({});
    expect(tasksHandle.registerTaskType).toHaveBeenCalledWith(
      "in_process_teammate",
      expect.objectContaining({ name: "InProcessTeammateTask" }),
    );
  });

  it("session_start registers the team_create tool", async () => {
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    const start = handlers.get("session_start")!;
    await start({});
    expect(pi.registerTool).toHaveBeenCalledTimes(3);
    const names = pi.registerTool.mock.calls.map(
      (c: unknown[]) => (c[0] as { name: string }).name,
    );
    expect(names).toContain("team_create");
    expect(names).toContain("send_message");
    expect(names).toContain("team_delete");
  });

  it("session_shutdown unregisters task type and resets stores", async () => {
    const { pi, handlers, tasksHandle } = buildFakePi();
    teammateExtension(pi as never);
    const { teamStore, mailbox } = getTeammateHandle(pi as never);
    teamStore.createTeam("t", undefined, 1);
    mailbox.registerReceiver("a", () => {});
    expect(teamStore.list()).toHaveLength(1);
    expect(mailbox.onlineAgents()).toEqual(["a"]);

    const shutdown = handlers.get("session_shutdown")!;
    await shutdown({});

    expect(tasksHandle.unregisterTaskType).toHaveBeenCalledWith(
      "in_process_teammate",
    );
    expect(teamStore.list()).toHaveLength(0);
    expect(mailbox.onlineAgents()).toEqual([]);
  });
});
