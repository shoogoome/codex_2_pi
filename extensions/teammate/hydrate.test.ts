import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  hydrateTeammateState,
  hydrateTeamTaskStore,
  respawnTeammates,
  _setHydrateSdkForTest,
  type SessionEntryLike,
} from "./hydrate.js";
import { TEAMMATE_EVENT_CUSTOM_TYPE } from "./eventEmit.js";
import type { TeammateEvent } from "./types.js";
import {
  createTaskStore,
  _setDefaultTaskStoreForTest,
} from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import { createApprovalRequestRegistry, type TeammateHandle } from "./handle.js";
import type { ReplayedState } from "./jsonlEvents.js";
import type { TeamTask } from "./teamTasks/types.js";
import { getAgentCapacity } from "../tasks/agentCapacityHandle.js";

const t1id = {
  agentId: "r@t1",
  agentName: "r",
  teamName: "t1",
  agentType: "general-purpose",
};

describe("hydrateTeammateState", () => {
  it("empty entries → empty state", () => {
    const state = hydrateTeammateState([]);
    expect(state).toEqual({
      teams: {},
      teammates: {},
      teamTasks: {},
      pendingMessages: {},
    });
  });

  it("rebuilds from team_create + teammate_spawn events", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", description: "ds", createdAt: 100 },
      {
        kind: "teammate_spawn",
        identity: t1id,
        sessionFile: "/tmp/r.jsonl",
        initialPrompt: "go",
      },
    ];
    const entries: SessionEntryLike[] = events.map((e) => ({
      type: "custom_message",
      customType: TEAMMATE_EVENT_CUSTOM_TYPE,
      details: e,
    }));
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeDefined();
    expect(state.teammates["r@t1"]?.lastStatus).toBe("running");
  });

  it("ignores entries with wrong customType", () => {
    const entries: SessionEntryLike[] = [
      {
        type: "custom_message",
        customType: "tasks/notification", // not ours
        details: { kind: "team_create", teamName: "t1", createdAt: 1 },
      },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t2", createdAt: 1 },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeUndefined();
    expect(state.teams["t2"]).toBeDefined();
  });

  it("ignores non-custom_message entries", () => {
    const entries: SessionEntryLike[] = [
      { type: "message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: { kind: "team_create", teamName: "t1", createdAt: 1 } },
      { type: "session" },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t2", createdAt: 1 },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeUndefined();
    expect(state.teams["t2"]).toBeDefined();
  });

  it("silently skips malformed details (no kind / not object)", () => {
    const entries: SessionEntryLike[] = [
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: undefined },
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: "not-an-object" },
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: {} },
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: { kind: 42 } },
      // valid one for sanity
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t1", createdAt: 1 },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeDefined();
  });

  it("replays full lifecycle: spawn → terminal → team_delete", () => {
    const entries: SessionEntryLike[] = [
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
          identity: t1id,
          sessionFile: "/tmp/r.jsonl",
          initialPrompt: "go",
        },
      },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "teammate_terminal", agentId: "r@t1", status: "completed" },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeDefined();
    expect(state.teammates["r@t1"]?.lastStatus).toBe("completed");
  });
});

interface FakePi {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
}

function buildPi(): FakePi {
  const names = [
    "read",
    "grep",
    "task_agent",
    "team_create",
    "team_delete",
    "send_message",
  ];
  return {
    events: {},
    sendMessage: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([...names]),
    getAllTools: vi.fn().mockReturnValue(names.map((name) => ({ name }))),
  };
}

describe("respawnTeammates", () => {
  beforeEach(() => {
    _setDefaultTaskStoreForTest(createTaskStore());
    _resetTaskOutputDirForTest();
    _setHydrateSdkForTest({});
  });
  afterEach(async () => {
    _setHydrateSdkForTest({});
    await _clearOutputsForTest();
    _setDefaultTaskStoreForTest(undefined);
  });

  it("respawns running teammates and skips terminal ones", async () => {
    const sessionMgrMock = vi.fn(() => ({
      getSessionFile: () => "/tmp/r.jsonl",
      getSessionId: () => "s-1",
      getEntries: () => [],
      appendMessage: vi.fn(),
    }));
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    const createSessionMock = vi.fn(async (_opts: unknown) => ({ session: fakeSession }));
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: sessionMgrMock,
      createAgentSessionFromServices: createSessionMock,
    });

    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          description: "x",
          createdAt: 1,
          memberAgentIds: ["alice@t1", "bob@t1"],
        },
      },
      teammates: {
        "alice@t1": {
          identity: {
            agentId: "alice@t1",
            agentName: "alice",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
        "bob@t1": {
          identity: {
            agentId: "bob@t1",
            agentName: "bob",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/bob.jsonl",
          initialPrompt: "go",
          lastStatus: "completed",
        },
      },
      teamTasks: {},
    };

    const taskStore = createTaskStore();
    const handle: TeammateHandle = {
      teamStore: createTeamStore(),
      mailbox: createMailbox(),
      teamTaskStore: createTeamTaskStore(),
      approvalRequests: createApprovalRequestRegistry(),
    };
    const result = await respawnTeammates(state, {
      pi: buildPi() as never,
      taskStore,
      handle,
      cwd: "/tmp",
    });
    expect(result.respawned).toEqual(["alice@t1"]);
    expect(result.skipped).toEqual(["bob@t1"]);
    expect(sessionMgrMock).toHaveBeenCalledWith("/tmp/alice.jsonl");
    // Task registered
    const tasks = Object.values(taskStore.get());
    expect(tasks).toHaveLength(1);
    expect(handle.teamStore.getTeam("t1")?.memberAgentIds).toContain("alice@t1");
    const sessionArgs = createSessionMock.mock.calls[0]![0] as {
      tools: string[];
      customTools?: Array<{ name?: string }>;
    };
    expect(sessionArgs.tools).toContain("request_plan_approval");
    expect(sessionArgs.customTools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "send_message",
        "request_plan_approval",
        "team_task_create",
        "team_task_update",
        "team_task_list",
        "team_task_get",
      ]),
    );
  });

  it("resume 时把 leader 的 provider/model 传给子 session", async () => {
    const open = vi.fn(() => ({
      getSessionFile: () => "/tmp/alice.jsonl",
      getSessionId: () => "s-1",
      getEntries: () => [],
      appendMessage: vi.fn(),
      // No model recorded in the session file → must inherit the leader's.
      buildSessionContext: () => ({ messages: [], thinkingLevel: "max", model: null }),
    }));
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    const createSessionMock = vi.fn(async (_opts: unknown) => ({ session: fakeSession }));
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: open,
      createAgentSessionFromServices: createSessionMock,
    });

    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          description: "x",
          createdAt: 1,
          memberAgentIds: ["alice@t1"],
        },
      },
      teammates: {
        "alice@t1": {
          identity: {
            agentId: "alice@t1",
            agentName: "alice",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
    };

    const leaderModel = { provider: "codebuddy", id: "deepseek-v4-pro-ioa" };
    await respawnTeammates(state, {
      pi: buildPi() as never,
      taskStore: createTaskStore(),
      handle: {
        teamStore: createTeamStore(),
        mailbox: createMailbox(),
        teamTaskStore: createTeamTaskStore(),
        approvalRequests: createApprovalRequestRegistry(),
      },
      cwd: "/tmp",
      parentRuntime: {
        model: leaderModel as never,
        modelRegistry: {
          find: () => undefined,
          hasConfiguredAuth: () => false,
        },
        thinkingLevel: "max" as never,
      },
    });

    const opts = createSessionMock.mock.calls[0]![0] as {
      model?: unknown;
      thinkingLevel?: unknown;
    };
    expect(opts.model).toBe(leaderModel);
    expect(opts.thinkingLevel).toBe("max");
  });

  it("resume 优先恢复子 session 自己记录的 provider/model", async () => {
    const open = vi.fn(() => ({
      getSessionFile: () => "/tmp/alice.jsonl",
      getSessionId: () => "s-1",
      getEntries: () => [],
      appendMessage: vi.fn(),
      buildSessionContext: () => ({
        messages: [],
        thinkingLevel: "max",
        model: { provider: "codebuddy", modelId: "deepseek-v4.1-flash" },
      }),
    }));
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    const createSessionMock = vi.fn(async (_opts: unknown) => ({ session: fakeSession }));
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: open,
      createAgentSessionFromServices: createSessionMock,
    });

    const recorded = { provider: "codebuddy", id: "deepseek-v4.1-flash" };
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          description: "x",
          createdAt: 1,
          memberAgentIds: ["alice@t1"],
        },
      },
      teammates: {
        "alice@t1": {
          identity: {
            agentId: "alice@t1",
            agentName: "alice",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
    };

    await respawnTeammates(state, {
      pi: buildPi() as never,
      taskStore: createTaskStore(),
      handle: {
        teamStore: createTeamStore(),
        mailbox: createMailbox(),
        teamTaskStore: createTeamTaskStore(),
        approvalRequests: createApprovalRequestRegistry(),
      },
      cwd: "/tmp",
      parentRuntime: {
        model: { provider: "game-studio", id: "gpt-5.6-sol" } as never,
        modelRegistry: {
          find: (provider: string, modelId: string) =>
            provider === "codebuddy" && modelId === "deepseek-v4.1-flash"
              ? (recorded as never)
              : undefined,
          hasConfiguredAuth: () => true,
        },
        thinkingLevel: "max" as never,
      },
    });

    const opts = createSessionMock.mock.calls[0]![0] as { model?: unknown };
    expect(opts.model).toBe(recorded);
  });

  it.each([
    ["missing-role", undefined, "no longer exists"],
    ["general-purpose", "stale-fingerprint", "changed since spawn"],
  ])(
    "fails closed when resume role %s is missing or changed",
    async (agentType, roleFingerprint, expectedError) => {
      const open = vi.fn();
      _setHydrateSdkForTest({
        createAgentSessionServices: vi.fn().mockResolvedValue({}),
        SessionManagerOpen: open,
        createAgentSessionFromServices: vi.fn(),
      });
      const agentId = `alice@t1`;
      const state: ReplayedState = {
        teams: {
          t1: {
            teamName: "t1",
            createdAt: 1,
            memberAgentIds: [agentId],
          },
        },
        teammates: {
          [agentId]: {
            identity: {
              agentId,
              agentName: "alice",
              teamName: "t1",
              agentType,
              ...(roleFingerprint ? { roleFingerprint } : {}),
            },
            sessionFile: "/tmp/alice.jsonl",
            initialPrompt: "go",
            lastStatus: "running",
          },
        },
        teamTasks: {},
      };
      const handle = buildHandle();
      const pi = buildPi();

      const result = await respawnTeammates(state, {
        pi: pi as never,
        taskStore: createTaskStore(),
        handle,
        cwd: "/tmp",
      });

      expect(result).toEqual({ respawned: [], skipped: [agentId] });
      expect(open).not.toHaveBeenCalled();
      expect(handle.teamStore.getTeam("t1")?.memberAgentIds).toEqual([]);
      expect(pi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            kind: "turn_error",
            agentId,
            error: expect.stringContaining(expectedError),
          }),
        }),
        { triggerTurn: true },
      );
    },
  );

  it("isolates one SDK resume failure, releases its slot, and continues", async () => {
    const goodSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(async (path: string) => {
        if (path.includes("broken")) throw new Error("corrupt child jsonl");
        return {};
      }),
      createAgentSessionFromServices: vi.fn(async () => ({ session: goodSession })),
    });
    const teammate = (name: string) => ({
      identity: {
        agentId: `${name}@t1`,
        agentName: name,
        teamName: "t1",
        agentType: "general-purpose",
      },
      sessionFile: `/tmp/${name}.jsonl`,
      initialPrompt: "go",
      lastStatus: "running" as const,
    });
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          createdAt: 1,
          memberAgentIds: ["broken@t1", "good@t1"],
        },
      },
      teammates: {
        "broken@t1": teammate("broken"),
        "good@t1": teammate("good"),
      },
      teamTasks: {},
    };
    const pi = buildPi();
    const handle = buildHandle();

    const result = await respawnTeammates(state, {
      pi: pi as never,
      taskStore: createTaskStore(),
      handle,
      cwd: "/tmp",
    });

    expect(result).toEqual({
      respawned: ["good@t1"],
      skipped: ["broken@t1"],
    });
    expect(handle.teamStore.getTeam("t1")?.memberAgentIds).toEqual(["good@t1"]);
    expect(getAgentCapacity(pi as never).snapshot().residentChildren).toBe(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          kind: "turn_error",
          agentId: "broken@t1",
          error: expect.stringContaining("corrupt child jsonl"),
        }),
      }),
      { triggerTurn: true },
    );
  });

  it("idempotent: skips re-respawn if a running teammate task with same agentId already exists", async () => {
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(() => ({
        getSessionFile: () => "/tmp/x.jsonl",
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
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          createdAt: 1,
          memberAgentIds: ["alice@t1"],
          description: undefined,
        },
      },
      teammates: {
        "alice@t1": {
          identity: {
            agentId: "alice@t1",
            agentName: "alice",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
    };
    const taskStore = createTaskStore();
    const handle: TeammateHandle = {
      teamStore: createTeamStore(),
      mailbox: createMailbox(),
      teamTaskStore: createTeamTaskStore(),
      approvalRequests: createApprovalRequestRegistry(),
    };
    await respawnTeammates(state, {
      pi: buildPi() as never,
      taskStore,
      handle,
      cwd: "/tmp",
    });
    // Second pass should be idempotent (no new task)
    const before = Object.keys(taskStore.get()).length;
    const r2 = await respawnTeammates(state, {
      pi: buildPi() as never,
      taskStore,
      handle,
      cwd: "/tmp",
    });
    expect(Object.keys(taskStore.get()).length).toBe(before);
    expect(r2.respawned).toEqual([]); // already running → skipped via idempotency
    expect(r2.skipped).toEqual(["alice@t1"]);
  });

  it("processes running teammates serially (createAgentSessionFromServices called sequentially)", async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    const secondSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(() => ({
        getSessionFile: () => "/tmp/x.jsonl",
        getSessionId: () => "s",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push("first-start");
          await new Promise<void>((r) => {
            resolveFirst = r;
          });
          order.push("first-end");
          return { session: firstSession };
        })
        .mockImplementationOnce(async () => {
          order.push("second-start");
          return { session: secondSession };
        }),
    });
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          createdAt: 1,
          memberAgentIds: ["a@t1", "b@t1"],
          description: undefined,
        },
      },
      teammates: {
        "a@t1": {
          identity: {
            agentId: "a@t1",
            agentName: "a",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/a.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
        "b@t1": {
          identity: {
            agentId: "b@t1",
            agentName: "b",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/b.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
    };
    const taskStore = createTaskStore();
    const handle: TeammateHandle = {
      teamStore: createTeamStore(),
      mailbox: createMailbox(),
      teamTaskStore: createTeamTaskStore(),
      approvalRequests: createApprovalRequestRegistry(),
    };
    const promise = respawnTeammates(state, {
      pi: buildPi() as never,
      taskStore,
      handle,
      cwd: "/tmp",
    });
    // Loading project/user roles may take longer under the full parallel suite;
    // wait for the observable first spawn rather than assuming 20 event-loop ticks.
    await vi.waitFor(() => {
      expect(order).toEqual(["first-start"]);
    });
    // The second spawn must still be blocked on the first deferred session.
    expect(order).not.toContain("second-start");
    resolveFirst();
    await promise;
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("respawned teammate registered in mailbox; messages delivered when sent", async () => {
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(() => ({
        getSessionFile: () => "/tmp/x.jsonl",
        getSessionId: () => "s",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fakeSession })),
    });
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          createdAt: 1,
          memberAgentIds: ["alice@t1"],
          description: undefined,
        },
      },
      teammates: {
        "alice@t1": {
          identity: {
            agentId: "alice@t1",
            agentName: "alice",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
    };
    const taskStore = createTaskStore();
    const handle: TeammateHandle = {
      teamStore: createTeamStore(),
      mailbox: createMailbox(),
      teamTaskStore: createTeamTaskStore(),
      approvalRequests: createApprovalRequestRegistry(),
    };
    const pi = buildPi();
    await respawnTeammates(state, {
      pi: pi as never,
      taskStore,
      handle,
      cwd: "/tmp",
    });
    // Loop is now in idle waiting on mailbox.
    handle.mailbox.send({
      id: "m1",
      from: "leader",
      to: "alice",
      body: "hi",
      timestamp: 1,
      isProtocol: false,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Loop should have triggered fakeSession.prompt with the formatted incoming msg
    expect(fakeSession.prompt).toHaveBeenCalled();
  });

  it("replays an unacknowledged canonical message and emits its ACK", async () => {
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(() => ({
        getSessionFile: () => "/tmp/x.jsonl",
        getSessionId: () => "s",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fakeSession })),
    });
    const identity = {
      agentId: "alice@t1",
      agentName: "alice",
      teamName: "t1",
      agentType: "general-purpose",
    };
    const durableMessage = {
      id: "m-replay",
      from: "leader",
      to: "alice@t1",
      body: "survive restart",
      timestamp: 10,
      isProtocol: false,
    };
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          createdAt: 1,
          memberAgentIds: [identity.agentId],
        },
      },
      teammates: {
        [identity.agentId]: {
          identity,
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
      pendingMessages: { [durableMessage.id]: durableMessage },
    };
    const handle = buildHandle();
    const pi = buildPi();

    await respawnTeammates(state, {
      pi: pi as never,
      taskStore: createTaskStore(),
      handle,
      cwd: "/tmp",
    });

    await vi.waitFor(() => {
      expect(fakeSession.prompt).toHaveBeenCalledWith(
        "[from leader] survive restart",
      );
    });
    await vi.waitFor(() => {
      const ack = pi.sendMessage.mock.calls.find(
        ([message]: unknown[]) =>
          (message as { details?: { kind?: string; messageId?: string } }).details
            ?.kind === "message_ack" &&
          (message as { details?: { messageId?: string } }).details?.messageId ===
            "m-replay",
      );
      expect(ack).toBeDefined();
    });
  });

  it("respawned teammate posts leader idle notification (kind='idle', triggerTurn:false) when its turn ends", async () => {
    const fakeSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
    };
    _setHydrateSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerOpen: vi.fn(() => ({
        getSessionFile: () => "/tmp/x.jsonl",
        getSessionId: () => "s",
        getEntries: () => [],
        appendMessage: vi.fn(),
      })),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fakeSession })),
    });
    const state: ReplayedState = {
      teams: {
        t1: {
          teamName: "t1",
          createdAt: 1,
          memberAgentIds: ["alice@t1"],
          description: undefined,
        },
      },
      teammates: {
        "alice@t1": {
          identity: {
            agentId: "alice@t1",
            agentName: "alice",
            teamName: "t1",
            agentType: "general-purpose",
          },
          sessionFile: "/tmp/alice.jsonl",
          initialPrompt: "go",
          lastStatus: "running",
        },
      },
      teamTasks: {},
    };
    const taskStore = createTaskStore();
    const handle: TeammateHandle = {
      teamStore: createTeamStore(),
      mailbox: createMailbox(),
      teamTaskStore: createTeamTaskStore(),
      approvalRequests: createApprovalRequestRegistry(),
    };
    const pi = buildPi();
    await respawnTeammates(state, {
      pi: pi as never,
      taskStore,
      handle,
      cwd: "/tmp",
    });
    // Trigger a message → turn → idle.
    handle.mailbox.send({
      id: "m1",
      from: "leader",
      to: "alice",
      body: "hi",
      timestamp: 1,
      isProtocol: false,
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const idleNotifications = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/notification" &&
        (m as { details?: { kind?: string } }).details?.kind === "idle",
    );
    expect(idleNotifications.length).toBeGreaterThanOrEqual(1);
    const first = idleNotifications[0]!;
    const msg = first[0] as {
      content: string;
      details: { kind: string; agentId: string };
    };
    const opts = first[1] as { triggerTurn?: boolean } | undefined;
    expect(msg.details.kind).toBe("idle");
    expect(msg.details.agentId).toBe("alice@t1");
    expect(opts).toEqual({ triggerTurn: false });
  });
});

function buildHandle(): TeammateHandle {
  return {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  };
}

function buildTask(overrides: Partial<TeamTask>): TeamTask {
  return {
    id: "tt-1",
    teamName: "research",
    subject: "investigate X",
    status: "pending",
    blockedBy: [],
    blocks: [],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe("hydrateTeamTaskStore", () => {
  it("copies state.teamTasks into the store (basic case: 2 tasks)", () => {
    const t1 = buildTask({ id: "tt-1", subject: "first" });
    const t2 = buildTask({ id: "tt-2", subject: "second", createdAt: 200, updatedAt: 200 });
    const state: ReplayedState = {
      teams: {},
      teammates: {},
      teamTasks: { "tt-1": t1, "tt-2": t2 },
    };
    const handle = buildHandle();
    const result = hydrateTeamTaskStore(state, handle);
    expect(result).toEqual({ hydrated: 2, skipped: 0 });
    expect(handle.teamTaskStore.list()).toHaveLength(2);
    expect(handle.teamTaskStore.getTask("tt-1")?.subject).toBe("first");
    expect(handle.teamTaskStore.getTask("tt-2")?.subject).toBe("second");
  });

  it("idempotent: skips tasks already present in the store", () => {
    const t1 = buildTask({ id: "tt-1" });
    const state: ReplayedState = {
      teams: {},
      teammates: {},
      teamTasks: { "tt-1": t1 },
    };
    const handle = buildHandle();
    // First call hydrates; second call should be a no-op (skipped:1).
    const r1 = hydrateTeamTaskStore(state, handle);
    expect(r1).toEqual({ hydrated: 1, skipped: 0 });
    const r2 = hydrateTeamTaskStore(state, handle);
    expect(r2).toEqual({ hydrated: 0, skipped: 1 });
    expect(handle.teamTaskStore.list()).toHaveLength(1);
  });

  it("applies non-default status via updateTask", () => {
    const t1 = buildTask({ id: "tt-1", status: "in_progress" });
    const state: ReplayedState = {
      teams: {},
      teammates: {},
      teamTasks: { "tt-1": t1 },
    };
    const handle = buildHandle();
    hydrateTeamTaskStore(state, handle);
    expect(handle.teamTaskStore.getTask("tt-1")?.status).toBe("in_progress");
  });

  it("applies updatedAt > createdAt via updateTask", () => {
    const t1 = buildTask({ id: "tt-1", createdAt: 100, updatedAt: 250 });
    const state: ReplayedState = {
      teams: {},
      teammates: {},
      teamTasks: { "tt-1": t1 },
    };
    const handle = buildHandle();
    hydrateTeamTaskStore(state, handle);
    expect(handle.teamTaskStore.getTask("tt-1")?.updatedAt).toBe(250);
    expect(handle.teamTaskStore.getTask("tt-1")?.createdAt).toBe(100);
  });

  it("reverse blocks re-accumulate when upstream is hydrated before downstream", () => {
    const upstream = buildTask({
      id: "tt-up",
      subject: "upstream",
      createdAt: 100,
      updatedAt: 100,
      blockedBy: [],
      blocks: ["tt-down"],
    });
    const downstream = buildTask({
      id: "tt-down",
      subject: "downstream",
      createdAt: 200,
      updatedAt: 200,
      blockedBy: ["tt-up"],
      blocks: [],
    });
    // Object.values preserves insertion order — upstream first, downstream second.
    const state: ReplayedState = {
      teams: {},
      teammates: {},
      teamTasks: { "tt-up": upstream, "tt-down": downstream },
    };
    const handle = buildHandle();
    const result = hydrateTeamTaskStore(state, handle);
    expect(result.hydrated).toBe(2);
    expect(handle.teamTaskStore.getTask("tt-up")?.blocks).toEqual(["tt-down"]);
    expect(handle.teamTaskStore.getTask("tt-down")?.blockedBy).toEqual(["tt-up"]);
  });

  it("empty state.teamTasks → 0 hydrated, 0 skipped", () => {
    const state: ReplayedState = {
      teams: {},
      teammates: {},
      teamTasks: {},
      pendingMessages: {},
    };
    const handle = buildHandle();
    const result = hydrateTeamTaskStore(state, handle);
    expect(result).toEqual({ hydrated: 0, skipped: 0 });
    expect(handle.teamTaskStore.list()).toEqual([]);
  });
});
