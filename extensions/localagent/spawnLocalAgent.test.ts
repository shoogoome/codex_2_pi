import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnLocalAgent, _setSdkForTest } from "./spawnLocalAgent.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { _resetProgressForTest } from "./progress.js";
import type { LocalAgentTaskState } from "./types.js";
import { createAgentCapacity } from "../tasks/agentCapacity.js";
import { attachAgentCapacity } from "../tasks/agentCapacityHandle.js";

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
  return {
    sessionId: "fake-session",
    messages: [],
    isStreaming: false,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
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
  fakePi.sendMessage.mockClear();
  _setSdkForTest({
    createAgentSessionServices: vi.fn().mockResolvedValue({}),
    SessionManagerForkFrom: vi.fn(() => forkSessionManager()),
    createAgentSessionFromServices: vi.fn(async () => ({ session: makeFakeSession() })),
  });
});

afterEach(async () => {
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
      SessionManagerForkFrom: forkFrom,
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });

    const result = await spawnLocalAgent(fakePi, createTaskStore(), forkOptions());

    expect(forkFrom).toHaveBeenCalledWith("/tmp/parent.jsonl", "/tmp");
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
