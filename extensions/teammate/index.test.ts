import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teammateExtension from "./index.js";
import { getTeammateHandle } from "./handle.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { TEAMMATE_EVENT_CUSTOM_TYPE } from "./eventEmit.js";
import { _setHydrateSdkForTest } from "./hydrate.js";

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
    getActiveTools: ReturnType<typeof vi.fn>;
  };
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  tasksHandle: ReturnType<typeof buildFakeTasksHandle>["handle"];
} {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const { handle: tasksHandle } = buildFakeTasksHandle();
  const pi = {
    on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) =>
      handlers.set(evt, h),
    ),
    events: { __pi_tasks_handle__: tasksHandle } as Record<string, unknown>,
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
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
    await start(
      {},
      {
        cwd: "/tmp",
        sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
      },
    );
    expect(tasksHandle.registerTaskType).toHaveBeenCalledWith(
      "in_process_teammate",
      expect.objectContaining({ name: "InProcessTeammateTask" }),
    );
  });

  it("session_start registers the team_create tool", async () => {
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    const start = handlers.get("session_start")!;
    await start(
      {},
      {
        cwd: "/tmp",
        sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
      },
    );
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
    await shutdown({}, {});

    expect(tasksHandle.unregisterTaskType).toHaveBeenCalledWith(
      "in_process_teammate",
    );
    expect(teamStore.list()).toHaveLength(0);
    expect(mailbox.onlineAgents()).toEqual([]);
  });

  it("session_start hydrates teammates from session jsonl entries", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const registerTaskTypeMock = vi.fn();
    const fakeTasksHandle = {
      store: createTaskStore(),
      registerTaskType: registerTaskTypeMock,
      getTaskType: () => undefined,
      unregisterTaskType: vi.fn(),
    };
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, handler);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
    } as never;

    teammateExtension(pi);

    // Inject hydrate SDK so respawn doesn't actually open files
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(() => ({
        getSessionFile: () => "/tmp/r.jsonl",
        getSessionId: () => "s",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: vi.fn(async () => ({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
      })),
    });

    // Mock ctx with getEntries returning a teammate_spawn event
    const fakeCtx = {
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [
          {
            type: "custom_message",
            customType: TEAMMATE_EVENT_CUSTOM_TYPE,
            details: { kind: "team_create", teamName: "t1", createdAt: 1 },
          },
          {
            type: "custom_message",
            customType: TEAMMATE_EVENT_CUSTOM_TYPE,
            details: {
              kind: "teammate_spawn",
              identity: {
                agentId: "alice@t1",
                agentName: "alice",
                teamName: "t1",
                agentType: "general-purpose",
              },
              sessionFile: "/tmp/alice.jsonl",
              initialPrompt: "go",
            },
          },
        ],
      },
    };

    (pi as unknown as { getActiveTools: ReturnType<typeof vi.fn> }).getActiveTools =
      vi.fn().mockReturnValue(["read", "send_message"]);

    const sessionStart = handlers.get("session_start")!;
    await sessionStart({}, fakeCtx);

    const handle = getTeammateHandle(pi);
    expect(handle.teamStore.getTeam("t1")).toBeDefined();
    // Task should be registered for alice
    const tasks = Object.values(fakeTasksHandle.store.get());
    expect(tasks.some((t) => t.type === "in_process_teammate")).toBe(true);

    _setHydrateSdkForTest({});
  });

  it("session_start hydration failure does not break extension load", async () => {
    // Make getEntries throw to simulate corrupt session
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const fakeTasksHandle = {
      store: createTaskStore(),
      registerTaskType: vi.fn(),
      getTaskType: () => undefined,
      unregisterTaskType: vi.fn(),
    };
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, handler);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
    } as never;
    teammateExtension(pi);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeCtx = {
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => {
          throw new Error("corrupt");
        },
      },
    };
    (pi as unknown as { getActiveTools: ReturnType<typeof vi.fn> }).getActiveTools =
      vi.fn().mockReturnValue([]);

    const sessionStart = handlers.get("session_start")!;
    await expect(sessionStart({}, fakeCtx)).resolves.not.toThrow();
    errSpy.mockRestore();
  });
});
