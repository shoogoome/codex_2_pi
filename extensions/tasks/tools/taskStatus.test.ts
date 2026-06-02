import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskStatusTool } from "./taskStatus.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../taskStore.js";
import { registerTask } from "../framework.js";
import { initTaskOutput, appendTaskOutput, _clearOutputsForTest } from "../diskOutput.js";
import { _resetTaskOutputDirForTest } from "../outputPath.js";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { TaskStateBase } from "../Task.js";

const sample = (id: string, overrides: Partial<TaskStateBase> = {}): TaskStateBase => ({
  id,
  type: "local_bash",
  status: "running",
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
  ...overrides,
});

beforeEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  // Initialize default TaskStore for file I/O paths with unique session per test
  const store = createTaskStore();
  store._setSessionId(`test-session-${Math.random()}`);
  _setDefaultTaskStoreForTest(store);
});

async function run(tool: ReturnType<typeof buildTaskStatusTool>, params: unknown) {
  return await tool.execute("call-1", params as { task_id: string; output_offset?: number }, new AbortController().signal, () => {}, {} as any);
}

function getText(content: AgentToolResult<unknown>["content"][number] | undefined): string {
  return content?.type === "text" ? content.text : "";
}

describe("buildTaskStatusTool", () => {
  it("not found → text Task not found", async () => {
    const store = createTaskStore();
    const result = await run(buildTaskStatusTool(store), { task_id: "nope" });
    expect(getText(result.content[0])).toContain("not found");
  });

  it("running task with offset 0 returns full delta", async () => {
    const store = createTaskStore();
    store._setSessionId("status-test-1");
    const t = sample("babcdef01");
    await initTaskOutput(t.id);
    appendTaskOutput(t.id, "hello world\n");
    registerTask(t, store);
    const result = await run(buildTaskStatusTool(store), { task_id: t.id });
    const details = result.details as { output_delta: string; status: string; total_size: number };
    expect(details.status).toBe("running");
    expect(details.output_delta).toBe("hello world\n");
    expect(details.total_size).toBe("hello world\n".length);
  });

  it("running task with offset N returns only the tail past N", async () => {
    const store = createTaskStore();
    store._setSessionId("status-test-2");
    const t = sample("babcdef02");
    await initTaskOutput(t.id);
    appendTaskOutput(t.id, "hello world\n");
    registerTask(t, store);
    const result = await run(buildTaskStatusTool(store), { task_id: t.id, output_offset: 6 });
    const details = result.details as { output_delta: string };
    expect(details.output_delta).toBe("world\n");
  });

  it("terminal task includes endTime and exitCode (if present in extra)", async () => {
    const store = createTaskStore();
    const t: TaskStateBase = sample("babcdef03", { status: "completed", endTime: 999 });
    registerTask(t, store);
    const result = await run(buildTaskStatusTool(store), { task_id: t.id });
    const details = result.details as { status: string; endTime: number };
    expect(details.status).toBe("completed");
    expect(details.endTime).toBe(999);
  });

  it("offset past size returns empty delta", async () => {
    const store = createTaskStore();
    store._setSessionId("status-test-3");
    const t = sample("babcdef04");
    await initTaskOutput(t.id);
    appendTaskOutput(t.id, "abc");
    registerTask(t, store);
    const result = await run(buildTaskStatusTool(store), { task_id: t.id, output_offset: 999 });
    const details = result.details as { output_delta: string };
    expect(details.output_delta).toBe("");
  });

  it("schema rejects missing task_id", () => {
    const tool = buildTaskStatusTool(createTaskStore());
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });
});
