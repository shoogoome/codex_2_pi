import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { killLocalAgentTask } from "./kill.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _resetProgressForTest, initProgress, getProgress } from "./progress.js";
import * as diskOutput from "../tasks/diskOutput.js";
import * as logging from "../tasks/logging.js";
import * as taskProgress from "../tasks/progress.js";
import { registerTask } from "../tasks/framework.js";
import { createTaskStateBase } from "../tasks/Task.js";
import type { LocalAgentTaskState } from "./types.js";

const fakePi: any = { events: {}, sendMessage: vi.fn(), appendEntry: vi.fn() };

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetProgressForTest();
  fakePi.sendMessage.mockReset();
  fakePi.appendEntry.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRunningTask(taskId: string): {
  state: LocalAgentTaskState;
  abort: any;
  dispose: any;
  cleanup: any;
} {
  const abort = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  const cleanup = vi.fn();
  const state: LocalAgentTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "local_agent",
      description: "x",
      outputFile: `/tmp/${taskId}.output`,
    }),
    type: "local_agent",
    status: "running",
    prompt: "x",
    agentType: "general-purpose",
    isBackgrounded: false,
    isFork: false,
    session: { abort, dispose } as any,
    cleanup,
  };
  return { state, abort, dispose, cleanup };
}

describe("killLocalAgentTask", () => {
  it("不存在的 task → no-op", async () => {
    const store = createTaskStore();
    await killLocalAgentTask(fakePi, store, "nope");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("已 terminal 的 task → no-op", async () => {
    const store = createTaskStore();
    const { state } = makeRunningTask("a1");
    state.status = "completed";
    registerTask(state, store);
    await killLocalAgentTask(fakePi, store, "a1");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("running task → status=killed,abort+cleanup+dispose 顺序: abort → cleanup → dispose,然后 notify", async () => {
    const store = createTaskStore();
    const { state, abort, dispose, cleanup } = makeRunningTask("a2");
    initProgress("a2", 0);
    registerTask(state, store);
    const order: string[] = [];
    abort.mockImplementation(async () => {
      order.push("abort");
    });
    cleanup.mockImplementation(() => {
      order.push("cleanup");
    });
    dispose.mockImplementation(() => {
      order.push("dispose");
    });
    fakePi.sendMessage.mockImplementation(() => {
      order.push("notify");
    });
    fakePi.appendEntry.mockImplementation(() => {
      order.push("progress");
    });

    await killLocalAgentTask(fakePi, store, "a2");
    expect(store.getTask("a2")?.status).toBe("killed");
    expect((store.getTask("a2") as LocalAgentTaskState).session).toBeUndefined();
    expect((store.getTask("a2") as LocalAgentTaskState).cleanup).toBeUndefined();
    // 终态通知走 sendMessage，进度记录走 appendEntry；两者都在清理后发生。
    expect(order).toEqual(["abort", "cleanup", "dispose", "notify", "progress"]);
    const customTypes = fakePi.sendMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { customType?: string }).customType,
    );
    expect(customTypes).toEqual(["tasks/notification"]);
    expect(fakePi.appendEntry.mock.calls.map(([customType]: [string]) => customType))
      .toEqual(["tasks/progress"]);
  });

  it.each(["tasks/notification", "tasks/progress"])("%s 投递失败仍清理且重复 kill 不重复 dispose", async (failingType) => {
    const store = createTaskStore();
    const { state, abort, dispose, cleanup } = makeRunningTask("delivery-failure");
    initProgress(state.id, 0);
    registerTask(state, store);
    const failure = new Error("delivery failed");
    const log = vi.spyOn(logging, "logError").mockImplementation(() => {});
    const evict = vi.spyOn(diskOutput, "evictTaskOutput").mockResolvedValue(undefined);
    fakePi.sendMessage.mockImplementation((message: { customType: string }) => {
      if (message.customType === failingType) throw failure;
    });
    fakePi.appendEntry.mockImplementation((customType: string) => {
      if (customType === failingType) throw failure;
    });

    await expect(killLocalAgentTask(fakePi, store, state.id)).resolves.toBeUndefined();
    expect(store.getTask(state.id)).toMatchObject({ status: "killed", session: undefined, cleanup: undefined });
    expect(getProgress(state.id)).toBeUndefined();
    expect(evict).toHaveBeenCalledWith(state.id);
    expect(log).toHaveBeenCalledWith(failure,
      failingType === "tasks/notification" ? "killLocalAgent notify" : "emitTaskProgress");
    expect(fakePi.sendMessage.mock.calls.map(([message]: [{ customType: string }]) => message.customType))
      .toEqual(["tasks/notification"]);
    expect(fakePi.appendEntry.mock.calls.map(([customType]: [string]) => customType))
      .toEqual(["tasks/progress"]);

    await killLocalAgentTask(fakePi, store, state.id);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledTimes(1);
    expect(fakePi.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakePi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("进度发布函数抛错仍清理进度和输出", async () => {
    const store = createTaskStore();
    const { state } = makeRunningTask("progress-failure");
    initProgress(state.id, 0);
    registerTask(state, store);
    const failure = new Error("progress failed");
    vi.spyOn(taskProgress, "emitTaskProgress").mockImplementation(() => { throw failure; });
    const evict = vi.spyOn(diskOutput, "evictTaskOutput").mockResolvedValue(undefined);
    const log = vi.spyOn(logging, "logError").mockImplementation(() => {});

    await expect(killLocalAgentTask(fakePi, store, state.id)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(failure, "killLocalAgent progress");
    expect(getProgress(state.id)).toBeUndefined();
    expect(evict).toHaveBeenCalledWith(state.id);
  });

  it("输出 eviction rejection 被接住并记录", async () => {
    const store = createTaskStore();
    const { state, dispose } = makeRunningTask("evict-failure");
    initProgress(state.id, 0);
    registerTask(state, store);
    const failure = new Error("evict failed");
    vi.spyOn(diskOutput, "evictTaskOutput").mockRejectedValue(failure);
    const log = vi.spyOn(logging, "logError").mockImplementation(() => {});

    await expect(killLocalAgentTask(fakePi, store, state.id)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(failure, "killLocalAgent evict output");
    expect(getProgress(state.id)).toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("abort throw 也不阻断后续清理", async () => {
    const store = createTaskStore();
    const { state, abort, dispose, cleanup } = makeRunningTask("a3");
    abort.mockRejectedValue(new Error("boom"));
    registerTask(state, store);
    await killLocalAgentTask(fakePi, store, "a3");
    expect(cleanup).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(store.getTask("a3")?.status).toBe("killed");
  });
});
