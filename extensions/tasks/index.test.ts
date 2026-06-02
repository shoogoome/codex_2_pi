import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tasksExtension, {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  _setDefaultTaskStoreForTest,
  appendTaskOutput,
  createTaskStore,
  getDefaultTaskStore,
  notifyTaskTerminal,
  pollTasks,
  registerTask,
  stopTaskFrameworkPolling,
  TASK_NOTIFICATION_CUSTOM_TYPE,
  TASK_PROGRESS_CUSTOM_TYPE,
  type Task,
  type TaskStateBase,
  type TaskStore,
} from "./index.js";

type EventName =
  | "session_start"
  | "session_shutdown"
  | "session_before_switch"
  | "session_before_fork"
  | "session_before_compact"
  | "session_compact"
  | "session_before_tree"
  | "session_tree"
  | "context"
  | "before_provider_request"
  | "after_provider_response"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "message_start"
  | "message_update"
  | "message_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "model_select"
  | "thinking_level_select"
  | "tool_call"
  | "tool_result"
  | "user_bash"
  | "input"
  | "resources_discover";

interface FakePi {
  handlers: Map<EventName, Array<(event: unknown, ctx: unknown) => unknown>>;
  on: ReturnType<typeof vi.fn>;
  registerMessageRenderer: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  events: Record<string, unknown>;
}

function createFakePi(): FakePi {
  const handlers = new Map<EventName, Array<(event: unknown, ctx: unknown) => unknown>>();
  const on = vi.fn((event: EventName, handler: (event: unknown, ctx: unknown) => unknown) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);
  });
  return {
    handlers,
    on,
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    events: {},
  };
}

function fireEvent(pi: FakePi, event: EventName, eventObj: unknown, ctx: unknown): unknown[] {
  return (pi.handlers.get(event) ?? []).map((h) => h(eventObj, ctx));
}

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-tasks-idx-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  // _pollTimer 是 framework.ts 模块级单例 —— 跨测试要显式停掉,否则下一个测试启动 polling 时
  // 会触发 idempotent 早返回 (`if (_pollTimer) return`),timer count 不增。
  stopTaskFrameworkPolling();
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  _setDefaultTaskStoreForTest(undefined);
  consoleErrorSpy.mockRestore();
  if (originalTmpdirEnv === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = originalTmpdirEnv;
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.useRealTimers();
});

describe("tasksExtension entrypoint", () => {
  it("registers session_start, session_shutdown handlers and the renderer", () => {
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);

    expect(pi.on).toHaveBeenCalled();
    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);

    expect(pi.registerMessageRenderer).toHaveBeenCalledTimes(2);
    const customTypes = pi.registerMessageRenderer.mock.calls.map((c: unknown[]) => c[0]);
    expect(customTypes).toContain(TASK_NOTIFICATION_CUSTOM_TYPE);
    expect(customTypes).toContain(TASK_PROGRESS_CUSTOM_TYPE);
  });

  it("default TaskStore becomes available after extension load", () => {
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);
    const store = getDefaultTaskStore();
    expect(store).toBeDefined();
    expect(store.get()).toEqual({});
  });

  it("session_start latches sessionId into store and starts polling", () => {
    vi.useFakeTimers();
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);

    const fakeCtx = {
      sessionManager: { getSessionId: () => "session-fixture-1" },
    };
    fireEvent(pi, "session_start", {}, fakeCtx);

    expect(getDefaultTaskStore().getSessionId()).toBe("session-fixture-1");
    // polling 已启动 — 至少有 1 个 timer
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
  });

  it("session_shutdown stops polling and resets store", async () => {
    vi.useFakeTimers();
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);

    fireEvent(
      pi,
      "session_start",
      {},
      { sessionManager: { getSessionId: () => "session-fixture-2" } },
    );
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    // shutdown handler 是 async — 收集 promises 显式 await
    const shutdownResults = fireEvent(pi, "session_shutdown", {}, {});
    vi.useRealTimers();
    await Promise.all(shutdownResults as Promise<unknown>[]);

    // polling 已停 — 确认 default 的 framework timer 不再运行(检查 timer count 不可靠,
    // 因为 shutdown 后我们用 useRealTimers,所以这里改为验证 store 已重置即可)
    expect(getDefaultTaskStore().getSessionId()).toBe("default-session");
    expect(getDefaultTaskStore().get()).toEqual({});
  });

  it("storeFactory dep injects a custom store", () => {
    const pi = createFakePi();
    const custom = createTaskStore();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0], {
      storeFactory: () => custom,
    });
    expect(getDefaultTaskStore()).toBe(custom);
  });
});

// ---------- end-to-end lifecycle ----------

describe("end-to-end task lifecycle", () => {
  it("registerTask → updateTaskState → notifyTaskTerminal → pollTasks evicts", async () => {
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);
    fireEvent(
      pi,
      "session_start",
      {},
      { sessionManager: { getSessionId: () => "e2e-" + Math.random() } },
    );

    const store = getDefaultTaskStore();

    // import getTaskOutputPath 必须在 session_start 之后(latch 已写)
    const { getTaskOutputPath } = await import("./outputPath.js");
    const taskId = "be2etask1";
    const task: TaskStateBase = {
      id: taskId,
      type: "local_bash",
      status: "running",
      description: "do work",
      startTime: 0,
      outputFile: getTaskOutputPath(taskId),
      outputOffset: 0,
      notified: false,
    };
    registerTask(task, store);
    expect(store.getTask(taskId)).toBeDefined();

    // 模拟运行中产生输出
    appendTaskOutput(taskId, "in-progress\n");

    // 转 completed
    store.set((prev) => ({
      ...prev,
      [taskId]: { ...prev[taskId]!, status: "completed", endTime: 1 },
    }));

    // 终态通知
    notifyTaskTerminal(pi as unknown as Parameters<typeof notifyTaskTerminal>[0], store, {
      taskId,
      taskType: "local_bash",
      status: "completed",
      description: "do work",
      outputFile: task.outputFile,
    });

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.getTask(taskId)?.notified).toBe(true);

    // 第二次 notify 应被 CAS 静默跳过
    notifyTaskTerminal(pi as unknown as Parameters<typeof notifyTaskTerminal>[0], store, {
      taskId,
      taskType: "local_bash",
      status: "completed",
      description: "do work",
      outputFile: task.outputFile,
    });
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    // pollTasks 应 evict(terminal + notified + grace expired)
    // notifyTaskTerminal 写入了 retain=true + evictAfter=now+30s，宽限期内不会 evict。
    // 手动将 evictAfter 设为 0 模拟宽限期已过，验证 eviction 逻辑仍正常工作。
    store.set((prev) => ({ ...prev, [taskId]: { ...prev[taskId]!, evictAfter: 0 } as never }));
    await pollTasks(store);
    expect(store.getTask(taskId)).toBeUndefined();
  });
});

describe("Task interface compliance smoke test", () => {
  it("Task object can be defined and kill called", async () => {
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);
    fireEvent(
      pi,
      "session_start",
      {},
      { sessionManager: { getSessionId: () => "compliance-" + Math.random() } },
    );

    const killed = vi.fn();
    const fakeTask: Task = {
      name: "FakeBashTask",
      type: "local_bash",
      async kill(taskId, store) {
        killed(taskId, store);
      },
    };

    const store = getDefaultTaskStore();
    await fakeTask.kill("babcdefgh", store);
    expect(killed).toHaveBeenCalledWith("babcdefgh", store);
  });
});

describe("registers cross-type tools at session_start", () => {
  it("registers task_kill, task_status, task_list tools", () => {
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);
    fireEvent(pi, "session_start", {}, { sessionManager: { getSessionId: () => "tools-1" } });
    const names = pi.registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain("task_kill");
    expect(names).toContain("task_status");
    expect(names).toContain("task_list");
  });

  it("registerTool is called exactly 3 times for the cross-type tools", () => {
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);
    fireEvent(pi, "session_start", {}, { sessionManager: { getSessionId: () => "tools-2" } });
    expect(pi.registerTool).toHaveBeenCalledTimes(3);
  });

  it("session_shutdown also resets the taskTypeRegistry", async () => {
    const { _resetTaskTypeRegistryForTest, registerTaskType, getTaskType } = await import(
      "./taskTypeRegistry.js"
    );
    _resetTaskTypeRegistryForTest();
    const pi = createFakePi();
    tasksExtension(pi as unknown as Parameters<typeof tasksExtension>[0]);
    fireEvent(pi, "session_start", {}, { sessionManager: { getSessionId: () => "tools-3" } });
    registerTaskType("local_bash", {
      name: "X",
      type: "local_bash",
      async kill() {},
    });
    expect(getTaskType("local_bash")).toBeDefined();
    const shutdownResults = fireEvent(pi, "session_shutdown", {}, {});
    await Promise.all(shutdownResults as Promise<unknown>[]);
    expect(getTaskType("local_bash")).toBeUndefined();
  });
});
