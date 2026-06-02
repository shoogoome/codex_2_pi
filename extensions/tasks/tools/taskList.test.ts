import { describe, expect, it } from "vitest";
import { buildTaskListTool } from "./taskList.js";
import { createTaskStore } from "../taskStore.js";
import { registerTask } from "../framework.js";
import type { TaskStateBase } from "../Task.js";

const sample = (id: string, status: TaskStateBase["status"] = "running"): TaskStateBase => ({
  id,
  type: "local_bash",
  status,
  description: `task ${id}`,
  startTime: 1000,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
});

async function run(tool: ReturnType<typeof buildTaskListTool>, params: unknown = {}) {
  return await tool.execute("call-1", params as { filter?: "running" | "all" }, new AbortController().signal, () => {}, {} as any);
}

describe("buildTaskListTool", () => {
  it("empty store returns []", async () => {
    const result = await run(buildTaskListTool(createTaskStore()));
    expect((result.details as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("filter=running excludes terminal tasks", async () => {
    const store = createTaskStore();
    registerTask(sample("b1", "running"), store);
    registerTask(sample("b2", "completed"), store);
    const result = await run(buildTaskListTool(store), { filter: "running" });
    const ids = (result.details as { tasks: { id: string }[] }).tasks.map((t) => t.id);
    expect(ids).toEqual(["b1"]);
  });

  it("filter=all includes terminal", async () => {
    const store = createTaskStore();
    registerTask(sample("b1", "running"), store);
    registerTask(sample("b2", "completed"), store);
    const result = await run(buildTaskListTool(store), { filter: "all" });
    const ids = (result.details as { tasks: { id: string }[] }).tasks.map((t) => t.id);
    expect(ids.sort()).toEqual(["b1", "b2"]);
  });

  it("default filter is running", async () => {
    const store = createTaskStore();
    registerTask(sample("b1", "running"), store);
    registerTask(sample("b2", "completed"), store);
    const result = await run(buildTaskListTool(store));
    const ids = (result.details as { tasks: { id: string }[] }).tasks.map((t) => t.id);
    expect(ids).toEqual(["b1"]);
  });

  it("each row contains id/type/status/description/startTime", async () => {
    const store = createTaskStore();
    registerTask(sample("b1", "running"), store);
    const result = await run(buildTaskListTool(store), { filter: "all" });
    const row = (result.details as { tasks: { id: string; type: string; status: string; description: string; startTime: number }[] }).tasks[0]!;
    expect(row.id).toBe("b1");
    expect(row.type).toBe("local_bash");
    expect(row.status).toBe("running");
    expect(row.description).toBe("task b1");
    expect(row.startTime).toBe(1000);
  });
});
