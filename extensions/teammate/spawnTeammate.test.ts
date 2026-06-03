import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnTeammate, _setSdkForTest } from "./spawnTeammate.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import type { TeammateHandle } from "./handle.js";
import type { InProcessTeammateTaskState } from "./types.js";

interface FakePi {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
}

const fakePi: FakePi = {
  events: {},
  sendMessage: vi.fn(),
  getActiveTools: vi.fn().mockReturnValue(["read", "grep", "task_agent", "team_create"]),
};

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  fakePi.sendMessage.mockClear();
  _setSdkForTest({
    createAgentSessionServices: vi.fn().mockResolvedValue({}),
    SessionManagerCreate: vi.fn(() => ({
      getSessionFile: () => "/tmp/spawned-teammate.jsonl",
      getSessionId: () => "tmsess-1",
      getEntries: () => [],
      appendMessage: vi.fn(),
    })),
    createAgentSessionFromServices: vi.fn(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(() => () => {}),
        sessionId: "tmsess-1",
        sessionFile: "/tmp/spawned-teammate.jsonl",
        messages: [],
        isStreaming: false,
      },
    })),
  });
});

afterEach(async () => {
  await _clearOutputsForTest();
});

function buildHandle(): TeammateHandle {
  return {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
  };
}

describe("spawnTeammate — happy path", () => {
  it("registers task + adds member + emits teammate_spawn event + returns identity", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", "research team", 100);
    const result = await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "find auth code",
      cwd: "/tmp",
    });
    expect(result.agentId).toBe("alice@research");
    expect(result.sessionFile).toBe("/tmp/spawned-teammate.jsonl");
    expect(typeof result.taskId).toBe("string");
    // Task in store
    const task = taskStore.getTask(result.taskId) as InProcessTeammateTaskState | undefined;
    expect(task).toBeDefined();
    expect(task!.identity.agentName).toBe("alice");
    expect(task!.identity.teamName).toBe("research");
    expect(task!.status).toBe("running");
    // Member added to team
    expect(handle.teamStore.getTeam("research")!.memberAgentIds).toEqual(["alice@research"]);
    // Event emitted
    const calls = fakePi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    const spawnCall = calls.find(
      ([m]: unknown[]) => (m as { details: { kind: string } }).details.kind === "teammate_spawn",
    );
    expect(spawnCall).toBeDefined();
    expect(
      (spawnCall![0] as { details: { identity: { agentId: string } } }).details.identity.agentId,
    ).toBe("alice@research");
  });

  it("starts teammateLoop with initial prompt → session.prompt called", async () => {
    const promptFn = vi.fn().mockResolvedValue(undefined);
    _setSdkForTest({
      createAgentSessionFromServices: vi.fn(async () => ({
        session: {
          prompt: promptFn,
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
      })),
    });
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 100);
    await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "go",
      cwd: "/tmp",
    });
    // Wait microtasks for loop to fire prompt
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(promptFn).toHaveBeenCalledWith("go");
  });

  it("filters out task_agent / team_create / team_delete from teammate's tool pool", async () => {
    const createSessionMock = vi.fn(
      async (_opts: { tools: readonly string[]; customTools?: readonly unknown[] }) => ({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
      }),
    );
    fakePi.getActiveTools.mockReturnValue([
      "read",
      "grep",
      "task_agent",
      "team_create",
      "team_delete",
      "send_message",
    ]);
    _setSdkForTest({
      createAgentSessionFromServices: createSessionMock,
    });
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 100);
    await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "go",
      cwd: "/tmp",
    });
    expect(createSessionMock).toHaveBeenCalled();
    const args = createSessionMock.mock.calls[0]![0];
    expect(args.tools).toContain("read");
    expect(args.tools).toContain("grep");
    expect(args.tools).toContain("send_message");
    expect(args.tools).not.toContain("task_agent");
    expect(args.tools).not.toContain("team_create");
    expect(args.tools).not.toContain("team_delete");

    // An identity-bound send_message must be injected as a customTool so the
    // teammate sub-session can resolve its sender without cross-realm ALS.
    const customTools = (args.customTools ?? []) as Array<{ name?: string }>;
    expect(customTools.some((t) => t?.name === "send_message")).toBe(true);
  });

  it("injects identity-bound request_plan_approval as customTool", async () => {
    const createSessionMock = vi.fn(
      async (_opts: { tools: readonly string[]; customTools?: readonly unknown[] }) => ({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
      }),
    );
    fakePi.getActiveTools.mockReturnValue(["read", "send_message"]);
    _setSdkForTest({
      createAgentSessionFromServices: createSessionMock,
    });
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 100);
    await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "go",
      cwd: "/tmp",
    });

    const args = createSessionMock.mock.calls[0]![0];
    const customTools = (args.customTools ?? []) as Array<{ name?: string }>;
    expect(customTools.some((t) => t?.name === "request_plan_approval")).toBe(true);
  });
});

describe("spawnTeammate — leader notification on idle", () => {
  it("posts a teammate/notification with kind='idle' on each idle event (triggerTurn:false)", async () => {
    const promptFn = vi.fn().mockResolvedValue(undefined);
    _setSdkForTest({
      createAgentSessionFromServices: vi.fn(async () => ({
        session: {
          prompt: promptFn,
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
        },
      })),
    });
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 100);
    await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "go",
      cwd: "/tmp",
    });
    // Wait microtasks for the loop to fire prompt + idle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const idleNotifications = fakePi.sendMessage.mock.calls.filter(
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
    expect(msg.details.agentId).toBe("alice@research");
    expect(msg.content).toContain("alice@research");
    expect(opts).toEqual({ triggerTurn: false });
  });
});

describe("spawnTeammate — validation errors", () => {
  it("throws if team does not exist", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    await expect(
      spawnTeammate(fakePi as never, taskStore, handle, {
        teamName: "ghost",
        agentName: "alice",
        agentType: "general-purpose",
        prompt: "go",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it("throws on duplicate agentId in same team (running task)", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 100);
    await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "go",
      cwd: "/tmp",
    });
    await expect(
      spawnTeammate(fakePi as never, taskStore, handle, {
        teamName: "research",
        agentName: "alice",
        agentType: "general-purpose",
        prompt: "go",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/already exists/);
  });
});
