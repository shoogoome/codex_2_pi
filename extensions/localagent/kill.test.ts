import { describe, it, expect, beforeEach, vi } from "vitest";
import { killLocalAgentTask } from "./kill.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _resetProgressForTest, initProgress } from "./progress.js";
import { registerTask } from "../tasks/framework.js";
import { createTaskStateBase } from "../tasks/Task.js";
import type { LocalAgentTaskState } from "./types.js";

const fakePi: any = { events: {}, sendMessage: vi.fn() };

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetProgressForTest();
  fakePi.sendMessage.mockClear();
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

    await killLocalAgentTask(fakePi, store, "a2");
    expect(store.getTask("a2")?.status).toBe("killed");
    expect((store.getTask("a2") as LocalAgentTaskState).session).toBeUndefined();
    expect((store.getTask("a2") as LocalAgentTaskState).cleanup).toBeUndefined();
    // notify 是 tasks/notification 的 sendMessage,后面紧跟一次 tasks/progress kind=kill
    // 的 sendMessage。两次在 notifyTaskTerminal 之后顺序触发。`tasks/summary` 已被
    // 移除(task_agent 的 renderResult 接管了终态展示)。
    expect(order).toEqual(["abort", "cleanup", "dispose", "notify", "notify"]);
    const customTypes = fakePi.sendMessage.mock.calls.map(
      (c: unknown[]) => (c[0] as { customType?: string }).customType,
    );
    expect(customTypes).toEqual(["tasks/notification", "tasks/progress"]);
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
