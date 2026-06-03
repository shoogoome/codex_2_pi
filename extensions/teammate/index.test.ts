import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teammateExtension from "./index.js";
import { getTeammateHandle } from "./handle.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { createTaskStateBase } from "../tasks/Task.js";
import { TEAMMATE_EVENT_CUSTOM_TYPE } from "./eventEmit.js";
import { _setHydrateSdkForTest } from "./hydrate.js";
import { InProcessTeammateTask } from "./killTeammate.js";
import type { InProcessTeammateTaskState } from "./types.js";
import {
  getLeaderChannel,
  _resetLeaderBridgeForTest,
} from "./leaderBridge.js";

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

  it("attaches a teamTaskStore on the handle (initially empty)", () => {
    const { pi } = buildFakePi();
    teammateExtension(pi as never);
    const handle = getTeammateHandle(pi as never);
    expect(handle.teamTaskStore).toBeDefined();
    expect(handle.teamTaskStore.get()).toEqual({});
    expect(typeof handle.teamTaskStore.createTask).toBe("function");
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

  it("registers send_message at the factory top-level (before session_start) so teammate sub-sessions get it", () => {
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    // send_message must be registered synchronously at extension load — NOT
    // deferred to session_start — because teammate sub-sessions never fire
    // session_start. (Regression guard for the missing-send_message bug.)
    const namesAtLoad = pi.registerTool.mock.calls.map(
      (c: unknown[]) => (c[0] as { name: string }).name,
    );
    expect(namesAtLoad).toContain("send_message");
    expect(namesAtLoad).not.toContain("team_create");
    expect(namesAtLoad).not.toContain("team_delete");
    // session_start handler exists but has not run yet.
    expect(handlers.has("session_start")).toBe(true);
  });

  it("registers all four team_task_* tools at the factory top-level (same rationale as send_message)", () => {
    // Teammate sub-sessions never fire session_start, so anything they need
    // must register synchronously at extension-load. Per spec §2.4 the team
    // task list is for leader↔teammate collaboration: all four tools must be
    // visible to teammates as well as the leader.
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    const namesAtLoad = pi.registerTool.mock.calls.map(
      (c: unknown[]) => (c[0] as { name: string }).name,
    );
    expect(namesAtLoad).toEqual(
      expect.arrayContaining([
        "team_task_create",
        "team_task_update",
        "team_task_list",
        "team_task_get",
      ]),
    );
    // Leader-only tools still gated behind session_start.
    expect(namesAtLoad).not.toContain("team_create");
    expect(namesAtLoad).not.toContain("team_delete");
    // session_start has not been fired — proving these registered at top-level.
    expect(handlers.has("session_start")).toBe(true);
  });

  it("session_start registers the leader-only tools (team_create + team_delete)", async () => {
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    pi.registerTool.mockClear();
    const start = handlers.get("session_start")!;
    await start(
      {},
      {
        cwd: "/tmp",
        sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
      },
    );
    const names = pi.registerTool.mock.calls.map(
      (c: unknown[]) => (c[0] as { name: string }).name,
    );
    expect(names).toContain("team_create");
    expect(names).toContain("team_delete");
    // send_message is registered at top-level, not in session_start.
    expect(names).not.toContain("send_message");
  });

  it("session_shutdown unregisters task type and resets stores", async () => {
    const { pi, handlers, tasksHandle } = buildFakePi();
    teammateExtension(pi as never);
    const { teamStore, mailbox, teamTaskStore } = getTeammateHandle(pi as never);
    teamStore.createTeam("t", undefined, 1);
    mailbox.registerReceiver("a", () => {});
    teamTaskStore.createTask({
      id: "tt1",
      teamName: "t",
      subject: "draft",
      createdAt: 1,
    });
    expect(teamStore.list()).toHaveLength(1);
    expect(mailbox.onlineAgents()).toEqual(["a"]);
    expect(Object.keys(teamTaskStore.get())).toEqual(["tt1"]);

    const shutdown = handlers.get("session_shutdown")!;
    await shutdown({}, {});

    expect(tasksHandle.unregisterTaskType).toHaveBeenCalledWith(
      "in_process_teammate",
    );
    expect(teamStore.list()).toHaveLength(0);
    expect(mailbox.onlineAgents()).toEqual([]);
    expect(teamTaskStore.get()).toEqual({});
  });

  it("leader session_start registers a leaderBridge channel; session_shutdown unregisters it", async () => {
    _resetLeaderBridgeForTest();
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);

    expect(getLeaderChannel()).toBeUndefined();

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: false,
      sessionManager: { getSessionId: () => "leader-s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    const channel = getLeaderChannel();
    expect(channel).toBeDefined();

    // deliver routes to the leader's pi.sendMessage as a teammate/notification
    channel!.deliver(
      { kind: "message", agentId: "alice@t1", to: "leader", body: "hi leader" },
      true,
    );
    const notif = pi.sendMessage.mock.calls.find(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/notification",
    );
    expect(notif).toBeDefined();
    expect((notif![1] as { triggerTurn?: boolean }).triggerTurn).toBe(true);

    await handlers.get("session_shutdown")!({}, fakeCtx);
    expect(getLeaderChannel()).toBeUndefined();
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

  it("session_start with hasUI=true sets up widget refresh that responds to team changes", async () => {
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
    const setWidgetMock = vi.fn();
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: { setWidget: setWidgetMock },
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [],
      },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // Initial refresh: empty teams → setWidget called with undefined
    expect(setWidgetMock).toHaveBeenCalledWith("teammate-team", undefined);

    // Now create a team via the handle — should trigger refresh
    const handle = getTeammateHandle(pi);
    setWidgetMock.mockClear();
    handle.teamStore.createTeam("research", undefined, 1);
    expect(setWidgetMock).toHaveBeenCalled();
    const lastCall =
      setWidgetMock.mock.calls[setWidgetMock.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe("teammate-team");
    expect(Array.isArray(lastCall[1])).toBe(true);
    expect(lastCall[2]).toEqual({ placement: "belowEditor" });

    // Cleanup so next tests are not affected by lingering listeners
    await handlers.get("session_shutdown")!({}, fakeCtx);
  });

  it("session_start with hasUI=false skips widget setup", async () => {
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
    const setWidgetMock = vi.fn();
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: false,
      ui: { setWidget: setWidgetMock },
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [],
      },
    };
    await handlers.get("session_start")!({}, fakeCtx);
    expect(setWidgetMock).not.toHaveBeenCalled();

    // Mutating the store should also not trigger setWidget (no subscription)
    const handle = getTeammateHandle(pi);
    handle.teamStore.createTeam("research", undefined, 1);
    expect(setWidgetMock).not.toHaveBeenCalled();

    await handlers.get("session_shutdown")!({}, fakeCtx);
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

  it("session_shutdown attempts to kill ALL running teammates even if one throws", async () => {
    const handlers = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >();
    const taskStore = createTaskStore();
    const fakeTasksHandle = {
      store: taskStore,
      registerTaskType: vi.fn(),
      getTaskType: () => undefined,
      unregisterTaskType: vi.fn(),
    };
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    // Register two running teammate tasks. One will throw on kill, one won't.
    const buildTeammate = (
      taskId: string,
      agentName: string,
      teamName: string,
    ): InProcessTeammateTaskState => ({
      ...createTaskStateBase({
        id: taskId,
        type: "in_process_teammate",
        description: `${agentName}@${teamName}`,
        outputFile: `/tmp/${taskId}.out`,
      }),
      type: "in_process_teammate",
      status: "running",
      identity: {
        agentId: `${agentName}@${teamName}`,
        agentName,
        teamName,
        agentType: "general-purpose",
      },
      prompt: "go",
      sessionFile: `/tmp/${agentName}.jsonl`,
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    });
    const aliceState = buildTeammate("alice-task", "alice", "team1");
    const bobState = buildTeammate("bob-task", "bob", "team1");
    registerTask(aliceState, taskStore);
    registerTask(bobState, taskStore);

    // Spy: replace InProcessTeammateTask.kill with a stub that throws for alice.
    const origKill = InProcessTeammateTask.kill;
    let bobKilled = false;
    InProcessTeammateTask.kill = vi.fn(async (taskId: string) => {
      if (taskId === aliceState.id) throw new Error("alice kill failed");
      if (taskId === bobState.id) {
        bobKilled = true;
        updateTaskState<InProcessTeammateTaskState>(taskId, taskStore, (t) => ({
          ...t,
          status: "killed",
        }));
      }
    }) as never;

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: false,
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // Now invoke shutdown — should not throw, and should kill bob.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handlers.get("session_shutdown")!({}, fakeCtx),
    ).resolves.not.toThrow();
    expect(bobKilled).toBe(true);
    errSpy.mockRestore();

    InProcessTeammateTask.kill = origKill;
  });
});
