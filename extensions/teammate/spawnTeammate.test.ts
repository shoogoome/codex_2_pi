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
import { createAgentCapacity } from "../tasks/agentCapacity.js";
import { attachAgentCapacity } from "../tasks/agentCapacityHandle.js";

interface FakePi {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  getAllTools: ReturnType<typeof vi.fn>;
}

function toolInfos(names: readonly string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

const fakePi: FakePi = {
  events: {},
  sendMessage: vi.fn(),
  getActiveTools: vi.fn().mockReturnValue(["read", "grep", "task_agent", "team_create"]),
  getAllTools: vi
    .fn()
    .mockReturnValue(toolInfos(["read", "grep", "task_agent", "team_create"])),
};

beforeEach(() => {
  fakePi.events = {};
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

  it("counts the initial turn as turnCount=1 (no special-casing of cause.kind=\"initial\")", async () => {
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
    const result = await spawnTeammate(fakePi as never, taskStore, handle, {
      teamName: "research",
      agentName: "alice",
      agentType: "general-purpose",
      prompt: "go",
      cwd: "/tmp",
    });
    // Wait microtasks for the loop to fire onTurnStart({kind:"initial"}).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const task = taskStore.getTask(result.taskId) as
      | InProcessTeammateTaskState
      | undefined;
    expect(task!.turnCount).toBe(1);
  });

  it("subscribes to AgentSession events on spawn and cleans up on terminal", async () => {
    const subscribeSpy = vi.fn(() => () => {});
    _setSdkForTest({
      createAgentSessionFromServices: vi.fn(async () => ({
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          abort: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: subscribeSpy,
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
    expect(subscribeSpy).toHaveBeenCalled();
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
    // The teammate's initial prompt is the user-supplied prompt prepended
    // with the cooperation-contract boilerplate (full tool access, ask
    // leader via request_plan_approval before mutating actions, send_message
    // for progress / questions). Identity is interpolated.
    expect(promptFn).toHaveBeenCalledTimes(1);
    const sentPrompt = promptFn.mock.calls[0]![0] as string;
    expect(sentPrompt.endsWith("go")).toBe(true);
    expect(sentPrompt).toContain("重要约定");
    expect(sentPrompt).toContain("request_plan_approval");
    expect(sentPrompt).toContain("send_message");
    expect(sentPrompt).toContain("alice");
    expect(sentPrompt).toContain("research");
    // Old "你没有 bash" framing must be gone — teammate now has full access.
    expect(sentPrompt).not.toContain("没有 bash");
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
    fakePi.getAllTools.mockReturnValue(
      toolInfos([
        "read",
        "grep",
        "task_agent",
        "team_create",
        "team_delete",
        "send_message",
        // Write-class tools — post-D2 reversal: these MUST remain in
        // teammate's pool (full execution access, gated by
        // request_plan_approval). Only recursion guards are stripped.
        "bash",
        "write",
        "edit",
        "task_bash",
        "task_kill",
      ]),
    );
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
    // post-D2 reversal: write-class tools MUST remain in teammate pool;
    // teammate is expected to call request_plan_approval before mutating
    // actions (see teammatePromptBoilerplate).
    expect(args.tools).toContain("bash");
    expect(args.tools).toContain("write");
    expect(args.tools).toContain("edit");
    expect(args.tools).toContain("task_bash");
    expect(args.tools).toContain("task_kill");

    // Cross-realm collaboration tools must all be identity-bound customTools.
    const customTools = (args.customTools ?? []) as Array<{ name?: string }>;
    expect(customTools.map((tool) => tool.name)).toEqual(
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
    fakePi.getAllTools.mockReturnValue(toolInfos(["read", "send_message"]));
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

  it("enforces the shared resident-thread limit before spawning another teammate", async () => {
    const capacity = createAgentCapacity({ maxThreads: 2, maxConcurrent: 2 });
    attachAgentCapacity(fakePi as never, capacity);
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
        agentName: "bob",
        agentType: "general-purpose",
        prompt: "go",
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/thread limit reached/);
    expect(capacity.snapshot().residentChildren).toBe(1);
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
