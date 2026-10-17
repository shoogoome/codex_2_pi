import { isForkWorker } from "./workerIdentity.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnLocalAgent, _setSdkForTest } from "./spawnLocalAgent.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { _resetProgressForTest, getProgress } from "./progress.js";
import { killLocalAgentTask } from "./kill.js";
import * as diskOutput from "../tasks/diskOutput.js";
import type { LocalAgentTaskState } from "./types.js";
import { createAgentCapacity } from "../tasks/agentCapacity.js";
import { attachAgentCapacity, getAgentCapacity } from "../tasks/agentCapacityHandle.js";

interface FakeSession {
  sessionId: string;
  messages: unknown[];
  isStreaming: boolean;
  emit(event: { type: string; [key: string]: unknown }): void;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe(listener: (event: unknown) => void): () => void;
}

function makeFakeSession(): FakeSession {
  const listeners = new Set<(event: unknown) => void>();
  let finish!: () => void;
  const run = new Promise<void>((resolve) => { finish = resolve; });
  return {
    sessionId: "fake-session",
    messages: [],
    isStreaming: false,
    emit(event) {
      for (const listener of listeners) listener(event);
      if (event.type === "agent_end") finish();
    },
    prompt: vi.fn().mockReturnValue(run),
    abort: vi.fn().mockImplementation(async () => { finish(); }),
    dispose: vi.fn(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const inheritedModel = {
  provider: "custom-provider",
  id: "custom-model",
  name: "Custom Model",
  reasoning: true,
} as never;

const fakePi: any = {
  events: {},
  sendMessage: vi.fn(),
  registerMessageRenderer: vi.fn(),
};

function forkOptions(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "inspect auth",
    ctxMessages: [],
    cwd: "/tmp",
    parentSessionFile: "/tmp/parent.jsonl",
    parentBranch: [],
    model: inheritedModel,
    thinkingLevel: "max" as const,
    allRegisteredTools: ["read", "bash", "task_agent"],
    ...overrides,
  };
}

function forkSessionManager(entries: readonly unknown[] = []) {
  return {
    getEntries: () => entries,
    appendMessage: vi.fn(),
    getSessionFile: () => "/tmp/forked.jsonl",
    getSessionId: () => "forked",
  };
}

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetProgressForTest();
  attachAgentCapacity(fakePi, createAgentCapacity());
  fakePi.sendMessage.mockReset();
  _setSdkForTest({
    createAgentSessionServices: vi.fn().mockResolvedValue({}),
    createContextFork: vi.fn(() => forkSessionManager()),
    createAgentSessionFromServices: vi.fn(async () => ({ session: makeFakeSession() })),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await _clearOutputsForTest();
});

describe("spawnLocalAgent — fork-only runtime", () => {
  it("缺少持久父 session 时拒绝启动", async () => {
    await expect(
      spawnLocalAgent(fakePi, createTaskStore(), forkOptions({ parentSessionFile: "" })),
    ).rejects.toThrow(/persisted parent session/i);
  });

  it("始终 fork 父 session、注入 fork 指令并立即后台化", async () => {
    const fake = makeFakeSession();
    const forkFrom = vi.fn(() => forkSessionManager());
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      createContextFork: forkFrom,
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });

    const result = await spawnLocalAgent(fakePi, createTaskStore(), forkOptions());

    expect(forkFrom).toHaveBeenCalledWith("/tmp/parent.jsonl", "/tmp", []);
    expect(result).toMatchObject({
      status: "running",
      backgrounded: true,
      agentType: "__fork__",
    });
    expect(fake.prompt).toHaveBeenCalledTimes(1);
    expect(fake.prompt.mock.calls[0]![0]).toContain("<fork_boilerplate>");
    expect(fake.prompt.mock.calls[0]![0]).toContain("inspect auth");

    fake.emit({ type: "agent_end", messages: [] });
    await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalled());
  });

  it("把主会话精确 provider/model 对象和 thinking 传给子会话", async () => {
    const fake = makeFakeSession();
    const createSession = vi.fn(async () => ({ session: fake }));
    _setSdkForTest({ createAgentSessionFromServices: createSession });

    await spawnLocalAgent(fakePi, createTaskStore(), forkOptions());

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: inheritedModel,
      thinkingLevel: "max",
      tools: ["read", "bash"],
    }));

    fake.emit({ type: "agent_end", messages: [] });
    await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalled());
  });

  it("任务状态固定标记为 fork/background 并记录继承的 provider/model", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => ({ session: fake })) });
    const store = createTaskStore();

    const result = await spawnLocalAgent(fakePi, store, forkOptions());
    const task = store.getTask(result.taskId) as LocalAgentTaskState;

    expect(task).toMatchObject({
      type: "local_agent",
      status: "running",
      agentType: "__fork__",
      model: "custom-provider/custom-model",
      isBackgrounded: true,
      isFork: true,
      forkParentSessionFile: "/tmp/parent.jsonl",
      session: fake,
    });

    fake.emit({ type: "agent_end", messages: [] });
    await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalled());
  });

  it("fork 子会话内禁止递归 fork", async () => {
    await expect(
      spawnLocalAgent(fakePi, createTaskStore(), forkOptions({
        ctxMessages: [{
          role: "user",
          content: [{ type: "text", text: "<fork_boilerplate>STOP</fork_boilerplate>" }],
        }],
      })),
    ).rejects.toThrow(/inside a forked worker/i);
  });
});

describe("spawnLocalAgent — progress and terminal delivery", () => {
  it("发布 task/tool 进度并镜像 token 与最近工具到任务状态", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => ({ session: fake })) });
    const store = createTaskStore();

    const result = await spawnLocalAgent(fakePi, store, forkOptions());
    fake.emit({ type: "tool_execution_start", toolName: "grep", args: { pattern: "foo" } });
    fake.emit({ type: "tool_execution_end", toolName: "grep", result: { hits: 3 }, isError: false });
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { totalTokens: 4321 },
      },
    });

    const task = store.getTask(result.taskId) as LocalAgentTaskState;
    expect(task.progress).toMatchObject({
      toolCallCount: 1,
      tokenCount: 4321,
      recentToolNames: ["grep"],
    });

    fake.emit({ type: "agent_end", messages: [] });
    await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalled());

    const kinds = fakePi.sendMessage.mock.calls
      .filter(([message]: unknown[]) => (message as { customType?: string }).customType === "tasks/progress")
      .map(([message]: unknown[]) => (message as { details: { kind: string } }).details.kind);
    expect(kinds).toEqual(expect.arrayContaining(["task_start", "tool_start", "tool_end", "task_end"]));
  });

  it("后台完成后自动通知主会话并携带最终回答", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => ({ session: fake })) });
    const store = createTaskStore();

    const result = await spawnLocalAgent(fakePi, store, forkOptions());
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fork final answer" }],
      },
    });
    fake.emit({ type: "agent_end", messages: [] });

    await vi.waitFor(() => {
      expect(store.getTask(result.taskId)?.status).toBe("completed");
    });
    const notification = fakePi.sendMessage.mock.calls.find(
      ([message]: unknown[]) => (message as { customType?: string }).customType === "tasks/notification",
    );
    expect(notification?.[0]).toMatchObject({
      details: {
        status: "completed",
        finalMessage: "fork final answer",
        extra: { agentType: "__fork__" },
      },
    });
    expect(fake.dispose).toHaveBeenCalled();
    expect((store.getTask(result.taskId) as LocalAgentTaskState).session).toBeUndefined();
    expect((store.getTask(result.taskId) as LocalAgentTaskState).cleanup).toBeUndefined();
  });

  it("模型错误以 failed 终态通知主会话", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => ({ session: fake })) });
    const store = createTaskStore();

    const result = await spawnLocalAgent(fakePi, store, forkOptions());
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "401 invalid child auth",
      },
    });
    fake.emit({ type: "agent_end", messages: [] });

    await vi.waitFor(() => expect(store.getTask(result.taskId)?.status).toBe("failed"));
    expect(store.getTask(result.taskId)).toMatchObject({ error: "401 invalid child auth" });
  });
});

describe("fork review activity", () => {
  it("registers root inheritance before child SDK startup and stays active after return", async () => {
    const { getTaskActivityHandle } = await import("../tasks/activity.js");
    const { taskOriginFromContext } = await import("../tasks/origin.js");
    const hub = getTaskActivityHandle();
    const session = makeFakeSession();
    const store = createTaskStore();
    const origin = { originSessionId: "fork-review-root", originSessionFile: "/parent", originCwd: "/repo" };
    _setSdkForTest({
      createAgentSessionFromServices: vi.fn(async () => {
        expect(taskOriginFromContext({ cwd: "/other", sessionManager: forkSessionManager() } as never)).toEqual(origin);
        return { session };
      }),
    });
    let release!: () => void;
    const baseline = new Promise<void>((r) => { release = r; });
    const events: string[] = [];
    const unsubscribe = hub.subscribe(async (e) => {
      if (e.originSessionId !== origin.originSessionId) return;
      events.push(e.phase);
      if (e.phase === "before-start") await baseline;
    });
    try {
      const spawning = spawnLocalAgent(fakePi, store, forkOptions({ ...origin, cwd: "/other" }));
      await vi.waitFor(() => expect(events).toEqual(["before-start"]));
      expect(session.prompt).not.toHaveBeenCalled();
      release();
      const result = await spawning;
      expect(result.backgrounded).toBe(true);
      expect(hub.getActive()).toContainEqual(expect.objectContaining({ taskId: result.taskId, originSessionId: origin.originSessionId, cwd: "/other" }));
      store._setSessionId("replacement");
      session.emit({ type: "agent_end" });
      await vi.waitFor(() => expect(events).toEqual(["before-start", "end"]));
      expect(store.getTask(result.taskId)?.originSessionId).toBe(origin.originSessionId);
    } finally { unsubscribe(); }
  });
});


describe("LocalAgent settlement and cleanup regressions", () => {
  function setup() {
    const fake = makeFakeSession();
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => ({ session: fake })) });
    return { fake, store: createTaskStore() };
  }

  function notifications() {
    return fakePi.sendMessage.mock.calls.filter(
      ([message]: any[]) => message.customType === "tasks/notification",
    );
  }

  async function expectReleased(fake: FakeSession, store: ReturnType<typeof createTaskStore>, id: string) {
    await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalledTimes(1));
    expect(store.getTask(id)).toMatchObject({ session: undefined, cleanup: undefined });
    expect(getProgress(id)).toBeUndefined();
    expect(getAgentCapacity(fakePi).snapshot()).toMatchObject({ residentChildren: 0, activeChildren: 0 });
  }

  it("waits for prompt settlement, clears a recovered error, and emits one terminal snapshot", async () => {
    const { fake, store } = setup();
    let finish!: () => void;
    fake.prompt.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const onProgress = vi.fn();
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions({ onProgress }));
    fake.emit({ type: "message_end", message: {
      role: "assistant", stopReason: "error", errorMessage: "transient 503", content: [],
    } });
    fake.emit({ type: "agent_end", willRetry: true });
    await Promise.resolve();
    expect(store.getTask(taskId)?.status).toBe("running");
    expect(notifications()).toHaveLength(0);
    expect(onProgress.mock.calls.filter(([s]) => s.lastEvent.kind === "task_end")).toHaveLength(0);
    fake.emit({ type: "message_end", message: {
      role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }],
    } });
    fake.emit({ type: "agent_end" });
    fake.emit({ type: "agent_settled" });
    expect(store.getTask(taskId)?.status).toBe("running");
    finish();
    await expectReleased(fake, store, taskId);
    expect(store.getTask(taskId)).toMatchObject({ status: "completed", error: undefined, result: { finalText: "recovered" } });
    expect(notifications()).toHaveLength(1);
    expect(onProgress.mock.calls.filter(([s]) => s.lastEvent.kind === "task_end").map(([s]) => s.status)).toEqual(["completed"]);
  });

  it.each(["error", "aborted"])("reports final %s as failed, not completed", async (stopReason) => {
    const { fake, store } = setup();
    const onProgress = vi.fn();
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions({ onProgress }));
    fake.emit({ type: "message_end", message: { role: "assistant", stopReason, content: [] } });
    fake.emit({ type: "agent_end" });
    await expectReleased(fake, store, taskId);
    expect(store.getTask(taskId)?.status).toBe("failed");
    expect(onProgress.mock.calls.filter(([s]) => s.lastEvent.kind === "task_end").map(([s]) => s.status)).toEqual(["failed"]);
  });

  it.each(["resolved", "rejected", "throws"])("cleans up when prompt %s without agent_end", async (mode) => {
    const { fake, store } = setup();
    fake.prompt.mockImplementation(() => {
      if (mode === "throws") throw new Error("sync prompt failure");
      return mode === "rejected" ? Promise.reject(new Error("prompt failure")) : Promise.resolve();
    });
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions());
    await expectReleased(fake, store, taskId);
    expect(store.getTask(taskId)?.status).toBe(mode === "resolved" ? "completed" : "failed");
    expect(notifications()).toHaveLength(1);
  });

  it("releases runtime and capacity when progress and terminal delivery throw", async () => {
    const { fake, store } = setup();
    fakePi.sendMessage.mockImplementation(() => { throw new Error("delivery unavailable"); });
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions());
    fake.emit({ type: "agent_end" });
    await expectReleased(fake, store, taskId);
    expect(store.getTask(taskId)?.status).toBe("completed");
  });

  it("still notifies and disposes if output flush/eviction fail", async () => {
    const { fake, store } = setup();
    vi.spyOn(diskOutput, "flushTaskOutput").mockRejectedValue(new Error("flush failed"));
    vi.spyOn(diskOutput, "evictTaskOutput").mockRejectedValue(new Error("eviction failed"));
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions());
    fake.emit({ type: "agent_end" });
    await expectReleased(fake, store, taskId);
    expect(notifications()).toHaveLength(1);
    expect(store.getTask(taskId)?.status).toBe("completed");
  });

  it("kill racing with prompt settlement owns the only terminal notification", async () => {
    const { fake, store } = setup();
    const onProgress = vi.fn();
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions({ onProgress }));
    await killLocalAgentTask(fakePi, store, taskId);
    await expectReleased(fake, store, taskId);
    expect(store.getTask(taskId)?.status).toBe("killed");
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]![0].details.status).toBe("killed");
    expect(onProgress.mock.calls.filter(([s]) => s.lastEvent.kind === "task_end")).toHaveLength(0);
  });
});


describe("fork speed bridge and worker registration", () => {
  it("passes the live parent speed reader into SDK services and retires identity on completion", async () => {
    const fake = makeFakeSession();
    let enabled = true;
    const readFastMode = () => ({ enabled, tier: "priority" as const });
    const services = vi.fn().mockResolvedValue({});
    _setSdkForTest({ createAgentSessionServices: services,
      createAgentSessionFromServices: vi.fn(async () => {
        expect(isForkWorker("/tmp/forked.jsonl")).toBe(true);
        return { session: fake };
      }),
    });
    await spawnLocalAgent(fakePi, createTaskStore(), forkOptions({ readFastMode }));
    const reader = services.mock.calls[0]![0].readFastMode;
    expect(reader).toBe(readFastMode);
    expect(reader().enabled).toBe(true);
    enabled = false;
    expect(reader().enabled).toBe(false);
    fake.emit({ type: "agent_end" });
    await vi.waitFor(() => expect(fake.dispose).toHaveBeenCalled());
    expect(isForkWorker("/tmp/forked.jsonl")).toBe(false);
  });

  it("removes worker identity and capacity when SDK child creation fails", async () => {
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => {
      expect(isForkWorker("/tmp/forked.jsonl")).toBe(true);
      throw new Error("SDK creation failed");
    }) });
    await expect(spawnLocalAgent(fakePi, createTaskStore(), forkOptions())).rejects.toThrow("SDK creation failed");
    expect(isForkWorker("/tmp/forked.jsonl")).toBe(false);
    expect(getAgentCapacity(fakePi).snapshot()).toMatchObject({ residentChildren: 0, activeChildren: 0 });
  });

  it("kill retires the identity as well as the SDK session", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({ createAgentSessionFromServices: vi.fn(async () => ({ session: fake })) });
    const store = createTaskStore();
    const { taskId } = await spawnLocalAgent(fakePi, store, forkOptions());
    expect(isForkWorker("/tmp/forked.jsonl")).toBe(true);
    await killLocalAgentTask(fakePi, store, taskId);
    expect(isForkWorker("/tmp/forked.jsonl")).toBe(false);
  });
});
