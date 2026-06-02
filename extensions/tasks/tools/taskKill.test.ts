import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskKillTool } from "./taskKill.js";
import { createTaskStore } from "../taskStore.js";
import { registerTask } from "../framework.js";
import {
  _resetTaskTypeRegistryForTest,
  registerTaskType,
} from "../taskTypeRegistry.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Task, TaskStateBase } from "../Task.js";

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

const killSpy = vi.fn();
const fakeTask: Task = {
  name: "FakeBash",
  type: "local_bash",
  async kill(taskId, store) {
    killSpy(taskId, store);
  },
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  killSpy.mockClear();
  _resetTaskTypeRegistryForTest();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

async function run(tool: ReturnType<typeof buildTaskKillTool>, params: unknown) {
  return await tool.execute("call-1", params as { task_id: string }, new AbortController().signal, () => {}, {} as any);
}

function getText(content: AgentToolResult<unknown>["content"][number] | undefined): string {
  return content?.type === "text" ? content.text : "";
}

describe("buildTaskKillTool", () => {
  it("returns tool definition with name task_kill and a typebox params schema", () => {
    const tool = buildTaskKillTool(createTaskStore());
    expect(tool.name).toBe("task_kill");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("not found → text 'Task not found'", async () => {
    const store = createTaskStore();
    const result = await run(buildTaskKillTool(store), { task_id: "nope" });
    expect(getText(result.content[0])).toBe("Task not found: nope");
  });

  it("already terminal → text 'Task already <status>'", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh", "completed"), store);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(getText(result.content[0])).toBe("Task already completed: babcdefgh");
  });

  it("type not registered → text 'Task type ... not registered'", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(getText(result.content[0])).toBe("Task type local_bash not registered");
  });

  it("running + registered → calls Task.kill once with (taskId, store)", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    registerTaskType("local_bash", fakeTask);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls[0]![0]).toBe("babcdefgh");
    expect(killSpy.mock.calls[0]![1]).toBe(store);
    expect(getText(result.content[0])).toBe("Killed: babcdefgh");
  });

  it("Task.kill throws → tool returns error text, does not crash", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registerTaskType("local_bash", {
      name: "FakeBash",
      type: "local_bash",
      async kill() {
        throw new Error("boom");
      },
    });
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    const text = getText(result.content[0]);
    expect(text).toContain("Failed to kill");
    expect(text).toContain("boom");
    errorSpy.mockRestore();
  });

  it("kill state unchanged means task.kill responsible — tool just calls", async () => {
    // Sanity: the tool itself doesn't mutate the store.
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    registerTaskType("local_bash", fakeTask);
    await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(store.getTask("babcdefgh")?.status).toBe("running");
  });

  it("returns details with kind=task_kill action", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    registerTaskType("local_bash", fakeTask);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect((result.details as { action: string }).action).toBe("kill");
  });
});
