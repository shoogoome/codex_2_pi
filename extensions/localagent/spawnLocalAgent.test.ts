import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnLocalAgent, _setSdkForTest } from "./spawnLocalAgent.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { _resetProgressForTest } from "./progress.js";
import { GENERAL_PURPOSE_AGENT, FORK_AGENT } from "./agentDefinitions/builtIn.js";
import type { LocalAgentTaskState } from "./types.js";

interface FakeSession {
  sessionId: string;
  messages: unknown[];
  isStreaming: boolean;
  emit(event: { type: string; [k: string]: unknown }): void;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: (l: (e: unknown) => void) => () => void;
}

function makeFakeSession(): FakeSession {
  const listeners = new Set<(e: unknown) => void>();
  return {
    sessionId: "fake-sess",
    messages: [],
    isStreaming: false,
    emit(e) {
      for (const l of listeners) l(e);
    },
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const fakePi: any = {
  events: {},
  sendMessage: vi.fn(),
  registerMessageRenderer: vi.fn(),
};

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetProgressForTest();
  fakePi.sendMessage.mockClear();
  _setSdkForTest({
    createAgentSessionServices: vi
      .fn()
      .mockResolvedValue({ cwd: "/tmp", agentDir: "/tmp/.pi", diagnostics: [] }),
    SessionManagerInMemory: vi.fn(() => ({
      getEntries: () => [],
      appendMessage: vi.fn(),
      getSessionFile: () => undefined,
      getSessionId: () => "sm-fake",
    })),
    SessionManagerForkFrom: vi.fn(),
    createAgentSessionFromServices: vi.fn(async () => ({ session: makeFakeSession() })),
  });
});

afterEach(async () => {
  await _clearOutputsForTest();
});

describe("spawnLocalAgent — sync mode", () => {
  it("非 fork + 默认同步 → 等 agent_end 后返完整 result", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "say hi",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    // wait until the task is registered (subscribe is set up afterwards)
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    fake.emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    fake.emit({ type: "agent_end", messages: [] });
    const result = await promise;
    expect(result.backgrounded).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("hello");
    expect(fake.dispose).toHaveBeenCalled();
  });

  it("assistant stopReason=error is surfaced as failed instead of empty completed", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "fail",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
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

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.finalText).toContain("401 invalid child auth");
    expect(store.getTask(result.taskId)).toMatchObject({
      status: "failed",
      error: "401 invalid child auth",
    });
  });
});

describe("spawnLocalAgent — auto-background", () => {
  it("超过 timeoutMs 还未 agent_end → 返 backgrounded,sub 继续跑", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "long",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 100,
    });
    // Drain microtasks so spawn completes initial setup.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    vi.useRealTimers();
    expect(result.backgrounded).toBe(true);
    expect(result.status).toBe("running");
    expect(fake.dispose).not.toHaveBeenCalled();
    const t = store.getTask(result.taskId) as LocalAgentTaskState | undefined;
    expect(t?.isBackgrounded).toBe(true);
  });
});

describe("spawnLocalAgent — explicit background", () => {
  it("forceBackground=true → 立即返 backgrounded,timeoutMs 被忽略", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "explicit",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      forceBackground: true,
      timeoutMs: 999_999,
    });
    expect(result.backgrounded).toBe(true);
    expect(result.status).toBe("running");
  });
});

describe("spawnLocalAgent — fork path", () => {
  it("agentDef === FORK_AGENT 但缺 parentSessionFile → throw", async () => {
    const store = createTaskStore();
    await expect(
      spawnLocalAgent(fakePi, store, {
        prompt: "x",
        agentDef: FORK_AGENT,
        ctxMessages: [],
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/persisted parent session/);
  });

  it("fork 路径强制后台 + 用 forkFrom 取 SM + injectPlaceholders + boilerplate prompt", async () => {
    const fake = makeFakeSession();
    const forkFromMock = vi.fn(() => ({
      getEntries: () => [],
      appendMessage: vi.fn(),
      getSessionFile: () => "/tmp/forked.jsonl",
      getSessionId: () => "forked",
    }));
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(),
      SessionManagerForkFrom: forkFromMock,
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "find auth bugs",
      agentDef: FORK_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      parentSessionFile: "/tmp/parent.jsonl",
    });
    expect(forkFromMock).toHaveBeenCalledWith("/tmp/parent.jsonl", "/tmp");
    expect(result.backgrounded).toBe(true);
    expect(fake.prompt).toHaveBeenCalled();
    const promptArg = fake.prompt.mock.calls[0]![0] as string;
    expect(promptArg).toContain("<fork_boilerplate>");
    expect(promptArg).toContain("find auth bugs");
  });
});

describe("spawnLocalAgent — recursion guard", () => {
  it("ctxMessages 含 boilerplate tag → throw", async () => {
    const store = createTaskStore();
    await expect(
      spawnLocalAgent(fakePi, store, {
        prompt: "x",
        agentDef: GENERAL_PURPOSE_AGENT,
        ctxMessages: [
          {
            role: "user",
            content: [{ type: "text", text: "<fork_boilerplate>STOP</fork_boilerplate>" }],
          },
        ],
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/inside a forked worker/i);
  });
});

describe("spawnLocalAgent — tasks/progress emission", () => {
  it("emits task_start / tool_start / tool_end / task_end progress messages", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    fakePi.sendMessage.mockClear();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "do work",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    fake.emit({ type: "tool_execution_start", toolName: "grep", args: { pattern: "foo" } });
    fake.emit({ type: "tool_execution_end", toolName: "grep", result: { hits: 3 }, isError: false });
    fake.emit({ type: "agent_end", messages: [] });
    await promise;

    const progressCalls = fakePi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/progress",
    );
    const kinds = progressCalls.map(
      ([msg]: unknown[]) => (msg as { details: { kind: string } }).details.kind,
    );
    expect(kinds).toContain("task_start");
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_end");
    expect(kinds).toContain("task_end");

    // Every progress message uses triggerTurn:false (no deliverAs).
    for (const call of progressCalls) {
      expect(call[1]).toEqual({ triggerTurn: false });
    }
  });

  it("tool_start summary contains tool name + args preview", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    fakePi.sendMessage.mockClear();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "do work",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    fake.emit({ type: "tool_execution_start", toolName: "grep", args: { pattern: "foo" } });
    fake.emit({ type: "agent_end", messages: [] });
    await promise;
    const toolStarts = fakePi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) =>
        (msg as { details?: { kind?: string } }).details?.kind === "tool_start",
    );
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0]![0] as { details: { summary: string } }).details.summary).toContain(
      "grep",
    );
    expect((toolStarts[0]![0] as { details: { summary: string } }).details.summary).toContain(
      "foo",
    );
  });
});

describe("spawnLocalAgent — registerTask state shape", () => {
  it("registerTask 写入 LocalAgentTaskState,type=local_agent,status=running", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "x",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
    });
    // wait until the task is registered
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const tasks = Object.values(store.get());
    expect(tasks).toHaveLength(1);
    const t = tasks[0] as LocalAgentTaskState;
    expect(t.type).toBe("local_agent");
    expect(t.status).toBe("running");
    expect(t.isFork).toBe(false);
    expect(t.session).toBe(fake);
    fake.emit({ type: "agent_end", messages: [] });
    await promise;
  });
});

describe("spawnLocalAgent — agentDef.background=true", () => {
  it("agentDef.background=true → 等价 forceBackground", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "x",
      agentDef: { ...GENERAL_PURPOSE_AGENT, background: true },
      ctxMessages: [],
      cwd: "/tmp",
    });
    expect(result.backgrounded).toBe(true);
  });
});

describe("spawnLocalAgent — progress mirroring to LocalAgentTaskState", () => {
  it("after tool_execution_start, task.progress.recentToolNames includes the tool", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "do work",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    fake.emit({ type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } });
    // mirror happens synchronously inside the listener
    const taskId = Object.keys(store.get())[0]!;
    const t = store.getTask(taskId) as LocalAgentTaskState;
    expect(t.progress?.recentToolNames).toContain("bash");
    expect(t.progress?.toolCallCount).toBe(1);
    fake.emit({ type: "agent_end", messages: [] });
    await promise;
  });

  it("after message_end with usage.totalTokens, task.progress.tokenCount equals total", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "do work",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { totalTokens: 4321 },
      },
    });
    const taskId = Object.keys(store.get())[0]!;
    const t = store.getTask(taskId) as LocalAgentTaskState;
    expect(t.progress?.tokenCount).toBe(4321);
    fake.emit({ type: "agent_end", messages: [] });
    await promise;
  });
});

describe("spawnLocalAgent — terminal behavior", () => {
  it("does NOT emit tasks/summary on sync completion (renderResult owns terminal row)", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    fakePi.sendMessage.mockClear();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "say hi",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    while (Object.keys(store.get()).length === 0) {
      await new Promise((r) => setImmediate(r));
    }
    fake.emit({ type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } });
    fake.emit({ type: "tool_execution_end", toolName: "bash", result: { ok: true }, isError: false });
    fake.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        usage: { totalTokens: 100 },
      },
    });
    fake.emit({ type: "agent_end", messages: [] });
    const result = await promise;

    const summaryCalls = fakePi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/summary",
    );
    const notificationCalls = fakePi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
    );
    expect(summaryCalls).toHaveLength(0);
    expect(notificationCalls).toHaveLength(0);
    // The foreground tool result is the only terminal delivery. The result
    // carries the timeline so task_agent's renderResult can
    // build an expanded view (Ctrl+O) without going back to disk.
    expect(result.timeline).toBeDefined();
    const kinds = (result.timeline ?? []).map((e) => e.kind);
    expect(kinds).toContain("task_start");
    expect(kinds).toContain("tool_start");
    expect(kinds).toContain("tool_end");
    expect(kinds).toContain("task_end");
  });

  it("does NOT emit tasks/summary when background finalizer completes", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({ getEntries: () => [], appendMessage: vi.fn() })),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    fakePi.sendMessage.mockClear();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "bg work",
      agentDef: { ...GENERAL_PURPOSE_AGENT, background: true },
      ctxMessages: [],
      cwd: "/tmp",
    });
    expect(result.backgrounded).toBe(true);

    fake.emit({ type: "agent_end", messages: [] });
    // Drain microtasks so the runBackgroundFinalizer settles.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
    }

    const summaryCalls = fakePi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/summary",
    );
    expect(summaryCalls.length).toBe(0);
  });
});
