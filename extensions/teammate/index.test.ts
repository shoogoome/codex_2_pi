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
import {
  _resetApprovalGateForTest,
  grantApproval,
  registerApprovalSession,
  runWithApprovalSession,
} from "./approvalGate.js";

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
    getAllTools: ReturnType<typeof vi.fn>;
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
    getAllTools: vi.fn().mockReturnValue([]),
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

  it("hard-blocks teammate mutations without turn approval", async () => {
    _resetApprovalGateForTest();
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    const toolCall = handlers.get("tool_call")!;
    const identity = {
      agentId: "writer@team",
      agentName: "writer",
      teamName: "team",
      agentType: "general-purpose",
    };
    registerApprovalSession("child-session", identity);

    const outsideChild = await toolCall(
      { toolName: "write", input: { path: "x" } },
      undefined,
    );
    expect(outsideChild).toBeUndefined();

    const blocked = await runWithApprovalSession("child-session", () =>
      toolCall({ toolName: "write", input: { path: "x" } }, undefined),
    );
    expect(blocked).toEqual(
      expect.objectContaining({ block: true, reason: expect.stringContaining("writer@team") }),
    );

    grantApproval("child-session");
    const allowed = await runWithApprovalSession("child-session", () =>
      toolCall({ toolName: "write", input: { path: "x" } }, undefined),
    );
    expect(allowed).toBeUndefined();
    _resetApprovalGateForTest();
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

  it("session_start registers the leader-only tools (team_create + team_delete + team_plan_approve)", async () => {
    const { pi, handlers } = buildFakePi();
    teammateExtension(pi as never);
    // Snapshot top-level registrations: team_plan_approve must NOT be there
    // — it is leader-only and gated behind session_start, just like
    // team_create / team_delete.
    const namesAtLoad = pi.registerTool.mock.calls.map(
      (c: unknown[]) => (c[0] as { name: string }).name,
    );
    expect(namesAtLoad).not.toContain("team_plan_approve");

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
    expect(names).toContain("team_plan_approve");
    // send_message is registered at top-level, not in session_start.
    expect(names).not.toContain("send_message");
  });

  it("session_shutdown unregisters task type and resets stores", async () => {
    const { pi, handlers, tasksHandle } = buildFakePi();
    teammateExtension(pi as never);
    const { teamStore, mailbox, teamTaskStore } = getTeammateHandle(pi as never);
    teamStore.createTeam("t", undefined, 1);
    mailbox.registerReceiver("a@t", () => {});
    teamTaskStore.createTask({
      id: "tt1",
      teamName: "t",
      subject: "draft",
      createdAt: 1,
    });
    expect(teamStore.list()).toHaveLength(1);
    expect(mailbox.onlineAgents()).toEqual(["a@t"]);
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
    (pi as unknown as { getAllTools: ReturnType<typeof vi.fn> }).getAllTools =
      vi.fn().mockReturnValue([{ name: "read" }, { name: "send_message" }]);
    (pi as unknown as { getAllTools: ReturnType<typeof vi.fn> }).getAllTools =
      vi.fn().mockReturnValue([{ name: "read" }, { name: "send_message" }]);

    const sessionStart = handlers.get("session_start")!;
    await sessionStart({}, fakeCtx);

    const handle = getTeammateHandle(pi);
    expect(handle.teamStore.getTeam("t1")).toBeDefined();
    // Task should be registered for alice
    const tasks = Object.values(fakeTasksHandle.store.get());
    expect(tasks.some((t) => t.type === "in_process_teammate")).toBe(true);

    _setHydrateSdkForTest({});
  });

  it("session_start hydrates team_task_* events into the teamTaskStore", async () => {
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
      getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;

    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [
          {
            type: "custom_message",
            customType: TEAMMATE_EVENT_CUSTOM_TYPE,
            details: {
              kind: "team_task_create",
              task: {
                id: "tt-1",
                teamName: "research",
                subject: "investigate X",
                status: "pending",
                blockedBy: [],
                blocks: [],
                createdAt: 100,
                updatedAt: 100,
              },
            },
          },
          {
            type: "custom_message",
            customType: TEAMMATE_EVENT_CUSTOM_TYPE,
            details: {
              kind: "team_task_update",
              taskId: "tt-1",
              teamName: "research",
              patch: { status: "in_progress" },
              updatedAt: 200,
            },
          },
        ],
      },
    };

    const sessionStart = handlers.get("session_start")!;
    await sessionStart({}, fakeCtx);

    const handle = getTeammateHandle(pi);
    const task = handle.teamTaskStore.getTask("tt-1");
    expect(task).toBeDefined();
    expect(task?.subject).toBe("investigate X");
    expect(task?.status).toBe("in_progress");
    expect(task?.updatedAt).toBe(200);
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
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const requestRender = vi.fn();
    const fakeTui = { requestRender };
    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: setWidgetMock,
        onTerminalInput: vi.fn(() => () => {}),
        setEditorComponent: vi.fn(),
      },
      sessionManager: {
        getSessionId: () => "s1",
        getEntries: () => [],
      },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // setWidget should be called once with the factory + aboveEditor.
    expect(setWidgetMock).toHaveBeenCalledTimes(1);
    const setWidgetCall = setWidgetMock.mock.calls[0]!;
    expect(setWidgetCall[0]).toBe("teammate-team");
    expect(typeof setWidgetCall[1]).toBe("function");
    expect(setWidgetCall[2]).toEqual({ placement: "aboveEditor" });

    // Invoke the factory to capture the TUI handle (mirrors the host's
    // mount sequence) so subsequent store changes can drive requestRender.
    const factory = setWidgetCall[1] as (
      tui: unknown,
      theme: unknown,
    ) => { render: (w: number) => string[] };
    const component = factory(fakeTui, {});
    // Component renders fresh state — empty initially.
    expect(component.render(80)).toEqual([]);

    // Now create a team via the handle — should trigger requestRender.
    const handle = getTeammateHandle(pi);
    requestRender.mockClear();
    handle.teamStore.createTeam("research", undefined, 1);
    expect(requestRender).toHaveBeenCalled();

    // Re-rendering after the change should now include the team line.
    const lines = component.render(80);
    expect(lines.some((l) => l.includes("research"))).toBe(true);

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
    getAllTools: vi.fn().mockReturnValue([]),
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
    (pi as unknown as { getAllTools: ReturnType<typeof vi.fn> }).getAllTools =
      vi.fn().mockReturnValue([]);

    const sessionStart = handlers.get("session_start")!;
    await expect(sessionStart({}, fakeCtx)).resolves.not.toThrow();
    errSpy.mockRestore();
  });

  it("session_shutdown suspends ALL running teammates even if one session abort throws", async () => {
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
    getAllTools: vi.fn().mockReturnValue([]),
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

    let bobSuspended = false;
    aliceState.session = {
      abort: vi.fn(async () => { throw new Error("alice abort failed"); }),
      dispose: vi.fn(),
    } as never;
    bobState.session = {
      abort: vi.fn(async () => { bobSuspended = true; }),
      dispose: vi.fn(),
    } as never;

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: false,
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // Now invoke shutdown — should not throw, and should still suspend bob.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      handlers.get("session_shutdown")!({ reason: "reload" }, fakeCtx),
    ).resolves.not.toThrow();
    expect(bobSuspended).toBe(true);
    expect(taskStore.getTask(aliceState.id)?.status).toBe("killed");
    expect(taskStore.getTask(bobState.id)?.status).toBe("killed");
    errSpy.mockRestore();
  });

  // ──────────────────────────────────────────────────────────────────────
  // D.4 — view-swap integration tests (editor swap + selectedAgentId widget)
  // ──────────────────────────────────────────────────────────────────────

  it("session_start with hasUI=true registers a terminal-input handler (D.3 keybindings wiring)", async () => {
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
    const onTerminalInputMock = vi.fn(() => () => {});
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: vi.fn(),
        onTerminalInput: onTerminalInputMock,
        setEditorComponent: vi.fn(),
      },
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);
    expect(onTerminalInputMock).toHaveBeenCalledTimes(1);
    await handlers.get("session_shutdown")!({}, fakeCtx);
  });

  it("widget render includes selectedAgentId highlight when viewState selects a teammate", async () => {
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
    const setWidgetMock = vi.fn();
    // Capture the registered terminal-input handler so the test can drive it.
    let capturedHandler:
      | ((data: string) => unknown)
      | undefined;
    const onTerminalInputMock = vi.fn((h: (data: string) => unknown) => {
      capturedHandler = h;
      return () => {
        capturedHandler = undefined;
      };
    });
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const requestRender = vi.fn();
    const fakeTui = { requestRender };
    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: setWidgetMock,
        onTerminalInput: onTerminalInputMock,
        setEditorComponent: vi.fn(),
      },
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // Mount the widget via its factory (mirrors host behaviour).
    const setWidgetCall = setWidgetMock.mock.calls[0]!;
    const factory = setWidgetCall[1] as (
      tui: unknown,
      theme: unknown,
    ) => { render: (w: number) => string[] };
    const component = factory(fakeTui, {});

    // Seed a team + running teammate so the cycle pool is non-empty.
    const handle = getTeammateHandle(pi);
    handle.teamStore.createTeam("t1", undefined, 1);
    const aliceState: InProcessTeammateTaskState = {
      ...createTaskStateBase({
        id: "alice-t",
        type: "in_process_teammate",
        description: "alice@t1",
        outputFile: "/tmp/alice.out",
      }),
      type: "in_process_teammate",
      status: "running",
      identity: {
        agentId: "alice@t1",
        agentName: "alice",
        teamName: "t1",
        agentType: "general-purpose",
      },
      prompt: "go",
      sessionFile: "/tmp/alice.jsonl",
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
    registerTask(aliceState, taskStore);
    handle.teamStore.addMember("t1", "alice@t1");

    // Press Ctrl+G to focus the panel; ↓ to select alice.
    expect(capturedHandler).toBeDefined();
    capturedHandler!("\x07");
    capturedHandler!("\x1b[B");

    // Render now should highlight alice with "▶ ● alice".
    const lines = component.render(80);
    expect(lines.some((l) => l.includes("▶ ● alice"))).toBe(true);
    // Header reflects focused state.
    expect(lines[0]).toContain("●");
    // requestRender should have been driven by the store/viewstate listeners.
    expect(requestRender).toHaveBeenCalled();

    await handlers.get("session_shutdown")!({}, fakeCtx);
  });

  it("entering teammate view installs a custom editor; exiting restores the default", async () => {
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
    let capturedHandler: ((data: string) => unknown) | undefined;
    const onTerminalInputMock = vi.fn((h: (data: string) => unknown) => {
      capturedHandler = h;
      return () => {
        capturedHandler = undefined;
      };
    });
    const setEditorComponentMock = vi.fn();
    const customMock = vi.fn(() => Promise.resolve());
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: vi.fn(),
        onTerminalInput: onTerminalInputMock,
        setEditorComponent: setEditorComponentMock,
        custom: customMock,
      },
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    // Seed running teammate.
    const handle = getTeammateHandle(pi);
    handle.teamStore.createTeam("t1", undefined, 1);
    const aliceState: InProcessTeammateTaskState = {
      ...createTaskStateBase({
        id: "alice-t",
        type: "in_process_teammate",
        description: "alice@t1",
        outputFile: "/tmp/alice.out",
      }),
      type: "in_process_teammate",
      status: "running",
      identity: {
        agentId: "alice@t1",
        agentName: "alice",
        teamName: "t1",
        agentType: "general-purpose",
      },
      prompt: "go",
      sessionFile: "/tmp/alice.jsonl",
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
    registerTask(aliceState, taskStore);
    handle.teamStore.addMember("t1", "alice@t1");

    // Ctrl+G to focus, ↓ to select; Enter to enter teammate view.
    setEditorComponentMock.mockClear();
    capturedHandler!("\x07");
    capturedHandler!("\x1b[B");
    capturedHandler!("\r");
    // Should have installed a factory (function), not undefined.
    const installCalls = setEditorComponentMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "function",
    );
    expect(installCalls.length).toBeGreaterThanOrEqual(1);

    // The keybindings layer in teammate view passes Esc through to the
    // swapped editor (whose onEscape calls deps.onExit → exitTeammateView).
    // Build the editor from the recorded factory and fire onEscape to drive
    // the exit, then assert setEditorComponent(undefined) restored default.
    setEditorComponentMock.mockClear();
    const factory = installCalls[0]![0] as (
      tui: unknown,
      theme: unknown,
      kb: unknown,
    ) => { onEscape?: () => void };
    const editor = factory(
      { requestRender: vi.fn() },
      { borderColor: "white" },
      { matches: () => false },
    );
    editor.onEscape!();
    expect(setEditorComponentMock).toHaveBeenCalledWith(undefined);

    await handlers.get("session_shutdown")!({}, fakeCtx);
  });

  it("session_shutdown unsubscribes keybindings + restores default editor", async () => {
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
    const inputUnsub = vi.fn();
    const onTerminalInputMock = vi.fn(() => inputUnsub);
    const setEditorComponentMock = vi.fn();
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);

    const fakeCtx = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: vi.fn(),
        onTerminalInput: onTerminalInputMock,
        setEditorComponent: setEditorComponentMock,
      },
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    await handlers.get("session_start")!({}, fakeCtx);

    setEditorComponentMock.mockClear();
    await handlers.get("session_shutdown")!({}, fakeCtx);
    expect(inputUnsub).toHaveBeenCalled();
    // Editor default restored on shutdown (last call should be undefined).
    expect(setEditorComponentMock).toHaveBeenCalledWith(undefined);
  });

  // ──────────────────────────────────────────────────────────────────────
  // D2 enhancement (Path Y) — full-screen overlay view-swap tests
  // ──────────────────────────────────────────────────────────────────────

  function buildPathYHarness(): {
    pi: ExtensionAPI;
    handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
    capturedHandlerRef: { current?: (data: string) => unknown };
    customMock: ReturnType<typeof vi.fn>;
    overlayHandle: { hide: ReturnType<typeof vi.fn> };
    overlayDoneRef: { current?: (value: void) => void };
    setEditorComponentMock: ReturnType<typeof vi.fn>;
    fakeCtx: Record<string, unknown>;
    seedTeammate: (state: InProcessTeammateTaskState) => void;
    taskStore: ReturnType<typeof createTaskStore>;
  } {
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
    const capturedHandlerRef: { current?: (data: string) => unknown } = {};
    const onTerminalInputMock = vi.fn((h: (data: string) => unknown) => {
      capturedHandlerRef.current = h;
      return () => {
        capturedHandlerRef.current = undefined;
      };
    });
    const overlayHandle = { hide: vi.fn() };
    const overlayDoneRef: { current?: (value: void) => void } = {};
    // ctx.ui.custom mock: invokes the factory immediately so the extension
    // can register its `done` callback (we capture it via overlayDoneRef);
    // returns a Promise that resolves only when `done` is called.
    const customMock = vi.fn(
      (
        factory: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: (v: void) => void,
        ) => unknown,
        opts?: { onHandle?: (h: unknown) => void },
      ) => {
        let resolveFn: (() => void) | undefined;
        const promise = new Promise<void>((resolve) => {
          resolveFn = () => resolve();
        });
        const realDone = (_v: void) => {
          resolveFn?.();
        };
        overlayDoneRef.current = realDone;
        factory({}, {}, {}, realDone);
        opts?.onHandle?.(overlayHandle);
        return promise;
      },
    );
    const pi: ExtensionAPI = {
      on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
        handlers.set(evt, h);
      }),
      events: { __pi_tasks_handle__: fakeTasksHandle },
      registerTool: vi.fn(),
      sendMessage: vi.fn(),
      getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    } as never;
    teammateExtension(pi);
    const setEditorComponentMock = vi.fn();
    const fakeCtx: Record<string, unknown> = {
      cwd: "/tmp",
      hasUI: true,
      ui: {
        setWidget: vi.fn(),
        onTerminalInput: onTerminalInputMock,
        setEditorComponent: setEditorComponentMock,
        custom: customMock,
      },
      sessionManager: { getSessionId: () => "s1", getEntries: () => [] },
    };
    return {
      pi,
      handlers,
      capturedHandlerRef,
      customMock,
      overlayHandle,
      overlayDoneRef,
      setEditorComponentMock,
      fakeCtx,
      taskStore,
      seedTeammate: (state: InProcessTeammateTaskState) => {
        registerTask(state, taskStore);
      },
    };
  }

  function aliceState(): InProcessTeammateTaskState {
    return {
      ...createTaskStateBase({
        id: "alice-t",
        type: "in_process_teammate",
        description: "alice@t1",
        outputFile: "/tmp/alice.out",
      }),
      type: "in_process_teammate",
      status: "running",
      identity: {
        agentId: "alice@t1",
        agentName: "alice",
        teamName: "t1",
        agentType: "general-purpose",
      },
      prompt: "go",
      sessionFile: "/tmp/alice.jsonl",
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
  }

  it("Path Y: viewState entering teammate kind opens a full-screen overlay via ctx.ui.custom", async () => {
    const h = buildPathYHarness();
    await h.handlers.get("session_start")!({}, h.fakeCtx);
    const handle = getTeammateHandle(h.pi);
    handle.teamStore.createTeam("t1", undefined, 1);
    h.seedTeammate(aliceState());
    handle.teamStore.addMember("t1", "alice@t1");

    h.capturedHandlerRef.current!("\x07"); // Ctrl+G focus
    h.capturedHandlerRef.current!("\x1b[B"); // ↓ select alice
    h.capturedHandlerRef.current!("\r"); // Enter — open teammate view

    expect(h.customMock).toHaveBeenCalledTimes(1);
    const opts = h.customMock.mock.calls[0]![1] as {
      overlay?: boolean;
      overlayOptions?: () => Record<string, unknown>;
    };
    expect(opts.overlay).toBe(true);
    expect(typeof opts.overlayOptions).toBe("function");
    const oo = opts.overlayOptions!();
    expect(oo.width).toBe("100%");
    expect(oo.maxHeight).toBe("100%");
    expect(oo.anchor).toBe("top-left");
    expect(oo.margin).toBe(0);
    // nonCapturing must be true — without it the overlay steals keyboard
    // focus from the swapped editor and Esc / typed input is routed to
    // the focus-less overlay component (which has no handleInput),
    // making the editor appear unresponsive. See teammateOverlay nonCapturing
    // commit for the user-visible regression.
    expect(oo.nonCapturing).toBe(true);
    // nonCapturing must be true — without it the overlay steals keyboard
    // focus from the swapped editor and Esc / typed input is routed to
    // the focus-less overlay component (which has no handleInput),
    // making the editor appear unresponsive. See teammateOverlay nonCapturing
    // commit for the user-visible regression.
    expect(oo.nonCapturing).toBe(true);

    await h.handlers.get("session_shutdown")!({}, h.fakeCtx);
  });

  it("Path Y: leaving teammate view (Esc on editor) calls done() on the overlay", async () => {
    const h = buildPathYHarness();
    await h.handlers.get("session_start")!({}, h.fakeCtx);
    const handle = getTeammateHandle(h.pi);
    handle.teamStore.createTeam("t1", undefined, 1);
    h.seedTeammate(aliceState());
    handle.teamStore.addMember("t1", "alice@t1");

    h.capturedHandlerRef.current!("\x07");
    h.capturedHandlerRef.current!("\x1b[B");
    h.capturedHandlerRef.current!("\r");
    expect(h.customMock).toHaveBeenCalledTimes(1);

    // The keybindings handler in teammate view passes Esc through to the
    // swapped editor (whose onEscape calls deps.onExit → exitTeammateView).
    // Build the editor from the recorded factory and fire onEscape; the
    // viewState reactor then hides the overlay.
    const installCalls = h.setEditorComponentMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "function",
    );
    expect(installCalls.length).toBeGreaterThanOrEqual(1);
    const factory = installCalls[0]![0] as (
      tui: unknown,
      theme: unknown,
      kb: unknown,
    ) => { onEscape?: () => void };
    const editor = factory(
      { requestRender: vi.fn() },
      { borderColor: "white" },
      { matches: () => false },
    );
    editor.onEscape!();
    expect(h.overlayHandle.hide).toHaveBeenCalled();

    await h.handlers.get("session_shutdown")!({}, h.fakeCtx);
  });

  it("Path Y: session_shutdown dismisses the overlay if still open", async () => {
    const h = buildPathYHarness();
    await h.handlers.get("session_start")!({}, h.fakeCtx);
    const handle = getTeammateHandle(h.pi);
    handle.teamStore.createTeam("t1", undefined, 1);
    h.seedTeammate(aliceState());
    handle.teamStore.addMember("t1", "alice@t1");

    h.capturedHandlerRef.current!("\x07");
    h.capturedHandlerRef.current!("\x1b[B");
    h.capturedHandlerRef.current!("\r");
    expect(h.customMock).toHaveBeenCalledTimes(1);

    h.overlayHandle.hide.mockClear();
    await h.handlers.get("session_shutdown")!({}, h.fakeCtx);
    // shutdown drives unsubWidget → dismissOverlay → handle.hide()
    expect(h.overlayHandle.hide).toHaveBeenCalled();
  });

  it("Path Y: viewState transitions to teammate kind for an unknown agentId — no overlay opened", async () => {
    const h = buildPathYHarness();
    await h.handlers.get("session_start")!({}, h.fakeCtx);
    const handle = getTeammateHandle(h.pi);
    // Two teammates; we will seed only alice but force the view onto a
    // different (non-existent) agentId by selecting alice and then mutating
    // the store — but a cleaner strategy: there is a brief window where
    // selecting the only present teammate, killing it, and then pressing
    // Enter would trip this path. Instead, exercise the guard directly: the
    // unsubViewSwap subscriber checks for `target` after viewState change.
    // We seed alice, select+enter (overlay opens), then exit, kill alice,
    // and assert custom was called only once.
    handle.teamStore.createTeam("t1", undefined, 1);
    h.seedTeammate(aliceState());
    handle.teamStore.addMember("t1", "alice@t1");

    h.capturedHandlerRef.current!("\x07");
    h.capturedHandlerRef.current!("\x1b[B");
    h.capturedHandlerRef.current!("\r");
    expect(h.customMock).toHaveBeenCalledTimes(1);

    // Exit teammate view.
    h.capturedHandlerRef.current!("\x1b");

    // Now mutate state to a teammate kind referring to an agent that has
    // never run. We simulate it by reaching into the runtime — easiest is
    // to drop alice from the task store and try entering view again; the
    // guard `if (target)` prevents a second custom() call.
    updateTaskState<InProcessTeammateTaskState>("alice-t", h.taskStore, (t) => ({
      ...t,
      status: "completed",
    }));
    // Re-enter the cycle: re-select (still selected) + Enter.
    h.capturedHandlerRef.current!("\x07");
    h.capturedHandlerRef.current!("\x1b[B");
    h.capturedHandlerRef.current!("\r");
    // No new overlay opened — alice is no longer running, so the agentId
    // lookup yields no isInProcessTeammateTask hit.
    expect(h.customMock).toHaveBeenCalledTimes(1);

    await h.handlers.get("session_shutdown")!({}, h.fakeCtx);
  });
});
