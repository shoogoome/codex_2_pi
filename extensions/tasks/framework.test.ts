import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evictTerminalTask,
  getRunningTasks,
  PANEL_GRACE_MS,
  POLL_INTERVAL_MS,
  pollTasks,
  registerTask,
  startTaskFrameworkPolling,
  stopTaskFrameworkPolling,
  STOPPED_DISPLAY_MS,
  updateTaskState,
} from "./framework.js";
import {
  _setDefaultTaskStoreForTest,
  createTaskStore,
  setDefaultTaskStore,
  type TaskStore,
} from "./taskStore.js";
import type { TaskStateBase } from "./Task.js";
import {
  _clearOutputsForTest,
  appendTaskOutput,
  flushTaskOutput,
} from "./diskOutput.js";
import { _resetTaskOutputDirForTest } from "./outputPath.js";

const sample = (id: string, status: TaskStateBase["status"] = "running"): TaskStateBase => ({
  id,
  type: "local_bash",
  status,
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
});

describe("constants", () => {
  it("exposes POLL_INTERVAL_MS / STOPPED_DISPLAY_MS / PANEL_GRACE_MS", () => {
    expect(POLL_INTERVAL_MS).toBe(1000);
    expect(STOPPED_DISPLAY_MS).toBe(3_000);
    expect(PANEL_GRACE_MS).toBe(30_000);
  });
});

describe("registerTask", () => {
  it("inserts task into store snapshot", () => {
    const store = createTaskStore();
    const task = sample("babcdefgh");
    registerTask(task, store);
    expect(store.getTask("babcdefgh")).toBe(task);
  });

  it("overwrites existing task with same id", () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh", "pending"), store);
    registerTask(sample("babcdefgh", "running"), store);
    expect(store.getTask("babcdefgh")?.status).toBe("running");
  });
});

describe("updateTaskState", () => {
  it("applies updater and notifies listener", () => {
    const store = createTaskStore();
    const listener = vi.fn();
    store.subscribe(listener);
    registerTask(sample("babcdefgh"), store);
    listener.mockClear();

    updateTaskState("babcdefgh", store, (t) => ({ ...t, description: "updated" }));
    expect(store.getTask("babcdefgh")?.description).toBe("updated");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when task does not exist", () => {
    const store = createTaskStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() => updateTaskState("nope", store, (t) => t)).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("early-returns (no listener notify) when updater returns same reference", () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    const listener = vi.fn();
    store.subscribe(listener);
    updateTaskState("babcdefgh", store, (t) => t);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("evictTerminalTask", () => {
  it("does not evict when task is non-terminal", () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh", "running"), store);
    evictTerminalTask("babcdefgh", store);
    expect(store.getTask("babcdefgh")).toBeDefined();
  });

  it("does not evict when notified=false", () => {
    const store = createTaskStore();
    registerTask({ ...sample("babcdefgh", "completed"), notified: false }, store);
    evictTerminalTask("babcdefgh", store);
    expect(store.getTask("babcdefgh")).toBeDefined();
  });

  it("evicts when terminal && notified", () => {
    const store = createTaskStore();
    registerTask({ ...sample("babcdefgh", "completed"), notified: true }, store);
    evictTerminalTask("babcdefgh", store);
    expect(store.getTask("babcdefgh")).toBeUndefined();
  });

  it("respects 'retain' grace — does not evict before evictAfter", () => {
    const store = createTaskStore();
    const task = {
      ...sample("babcdefgh", "completed"),
      notified: true,
      retain: true,
      evictAfter: Date.now() + 60_000,
    } as TaskStateBase & { retain: boolean; evictAfter: number };
    registerTask(task, store);
    evictTerminalTask("babcdefgh", store);
    expect(store.getTask("babcdefgh")).toBeDefined();
  });

  it("evicts when 'retain' present but evictAfter passed", () => {
    const store = createTaskStore();
    registerTask(
      {
        ...sample("babcdefgh", "completed"),
        notified: true,
        retain: true,
        evictAfter: Date.now() - 1,
      } as TaskStateBase & { retain: boolean; evictAfter: number },
      store,
    );
    evictTerminalTask("babcdefgh", store);
    expect(store.getTask("babcdefgh")).toBeUndefined();
  });
});

describe("getRunningTasks", () => {
  it("filters to status='running'", () => {
    const snapshot = {
      a: sample("a", "running"),
      b: sample("b", "completed"),
      c: sample("c", "pending"),
      d: sample("d", "running"),
    };
    const ids = getRunningTasks(snapshot)
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["a", "d"]);
  });
});

// ---------- pollTasks ----------

describe("pollTasks", () => {
  let tmpRoot: string;
  let originalTmpdirEnv: string | undefined;
  let store: TaskStore;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "pi-tasks-fw-test-"));
    originalTmpdirEnv = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    store = createTaskStore();
    store._setSessionId("fw-session-" + Math.random().toString(36).slice(2));
    setDefaultTaskStore(store);
    _resetTaskOutputDirForTest();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
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
      /* noop */
    }
  });

  it("evicts terminal+notified tasks", async () => {
    registerTask({ ...sample("babcdefgh", "completed"), notified: true }, store);
    const result = await pollTasks(store);
    expect(result.evictedTaskIds).toEqual(["babcdefgh"]);
    expect(store.getTask("babcdefgh")).toBeUndefined();
  });

  it("does not evict terminal but un-notified", async () => {
    registerTask(sample("babcdefgh", "completed"), store);
    const result = await pollTasks(store);
    expect(result.evictedTaskIds).toEqual([]);
    expect(store.getTask("babcdefgh")).toBeDefined();
  });

  it("advances outputOffset for running tasks with new disk content", async () => {
    const taskId = "brunntsk1";
    // running task,outputFile 由模板算
    const { getTaskOutputPath } = await import("./outputPath.js");
    registerTask(
      {
        ...sample(taskId, "running"),
        outputFile: getTaskOutputPath(taskId),
      },
      store,
    );
    appendTaskOutput(taskId, "hello world");
    await flushTaskOutput(taskId);

    const result = await pollTasks(store);
    expect(result.updatedTaskOffsets[taskId]).toBe(11);
    expect(store.getTask(taskId)?.outputOffset).toBe(11);
  });

  it("does not advance offset for completed task even if disk has data", async () => {
    const taskId = "bcompdone";
    const { getTaskOutputPath } = await import("./outputPath.js");
    registerTask(
      {
        ...sample(taskId, "completed"),
        notified: false, // notified=false → 既不 evict 也不 advance
        outputFile: getTaskOutputPath(taskId),
      },
      store,
    );
    appendTaskOutput(taskId, "post-completion");
    await flushTaskOutput(taskId);

    const result = await pollTasks(store);
    expect(result.updatedTaskOffsets).toEqual({});
    expect(store.getTask(taskId)?.outputOffset).toBe(0);
  });
});

describe("startTaskFrameworkPolling / stopTaskFrameworkPolling", () => {
  it("startTaskFrameworkPolling registers a setInterval timer; stop clears it", () => {
    vi.useFakeTimers();
    try {
      const store = createTaskStore();
      setDefaultTaskStore(store);
      startTaskFrameworkPolling(store, 1000);
      expect(vi.getTimerCount()).toBe(1);
      stopTaskFrameworkPolling();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      _setDefaultTaskStoreForTest(undefined);
    }
  });

  it("starting twice without stop is idempotent (single timer)", () => {
    vi.useFakeTimers();
    try {
      const store = createTaskStore();
      setDefaultTaskStore(store);
      startTaskFrameworkPolling(store, 1000);
      startTaskFrameworkPolling(store, 1000);
      expect(vi.getTimerCount()).toBe(1);
      stopTaskFrameworkPolling();
    } finally {
      vi.useRealTimers();
      _setDefaultTaskStoreForTest(undefined);
    }
  });
});
