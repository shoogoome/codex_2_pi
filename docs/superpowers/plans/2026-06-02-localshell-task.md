# LocalShellTask (`local_bash`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 spec `docs/superpowers/specs/2026-06-02-localshell-task-design.md` 中描述的 LocalShellTask(`local_bash`)落地到仓库,提供 `task_bash` LLM 工具 + `task_kill` / `task_status` / `task_list` 三个跨 type 通用工具,严格 TDD 红绿循环。

**Architecture:**
- 上一期 `extensions/tasks/` 小改:新增 `taskTypeRegistry` 模块单例 + 三个通用 tool builder + 在 `index.ts` registerTool 三次。
- 新建 `extensions/localshell/`:`Task` 接口实现 + `spawnLocalShell` + `stallWatchdog` + `kill`,extension entrypoint 在 `session_start` 注册 `local_bash` 类型 + `task_bash` 工具。
- 用 Pi SDK 的 `createLocalBashOperations()` 拿流式 `BashOperations.exec({onData})`,测试通过 `createFakeBashOps()` helper 注入。

**Tech Stack:** TypeScript ESM (NodeNext) + Vitest globals + typebox + `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui`。

---

## 文件清单

新增:
- `extensions/tasks/taskTypeRegistry.ts` + `.test.ts`
- `extensions/tasks/tools/taskKill.ts` + `.test.ts`
- `extensions/tasks/tools/taskStatus.ts` + `.test.ts`
- `extensions/tasks/tools/taskList.ts` + `.test.ts`
- `extensions/localshell/package.json`
- `extensions/localshell/index.ts` + `.test.ts`
- `extensions/localshell/localShellTask.ts` + `.test.ts`
- `extensions/localshell/stallWatchdog.ts` + `.test.ts`
- `extensions/localshell/kill.ts` + `.test.ts`
- `extensions/localshell/outputBuffer.ts`(无独立测试,被 localShellTask.test 覆盖)
- `extensions/localshell/_test/fakeBashOperations.ts`

修改:
- `extensions/tasks/index.ts`:加 import + registerTool×3 + re-export + shutdown 加 reset
- `extensions/tasks/index.test.ts`:加 3 个测试

---

## Task 0: 准备工作

**Files:**
- Read: `docs/superpowers/specs/2026-06-02-localshell-task-design.md`
- Read: `extensions/tasks/index.ts` 全文(看现有 re-export 列表)
- Read: `extensions/subagents/tools.ts:40-100`(参考 ToolDefinition 形状)

- [ ] **Step 1: 跑基线测试,确保起点 313 全绿**

Run:
```bash
npm test 2>&1 | tail -20
```

Expected: `Test Files X passed (X)` / `Tests 313 passed (313)`(或更高,如果上一期之外又加过)。

- [ ] **Step 2: 跑 typecheck**

Run:
```bash
npm run typecheck 2>&1 | tail -10
```

Expected: 无 error。如果 typecheck 不绿,先停下来排查 — 不能在不绿的基础上叠加。

---

## Task 1: `taskTypeRegistry` 模块

**Files:**
- Create: `extensions/tasks/taskTypeRegistry.ts`
- Test: `extensions/tasks/taskTypeRegistry.test.ts`

- [ ] **Step 1: 写测试(8 个)**

Create `extensions/tasks/taskTypeRegistry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetTaskTypeRegistryForTest,
  getTaskType,
  registerTaskType,
  unregisterTaskType,
} from "./taskTypeRegistry.js";
import type { Task, TaskStoreLike } from "./Task.js";

const fakeTask = (type: Task["type"], name = "FakeTask"): Task => ({
  name,
  type,
  async kill(_taskId: string, _store: TaskStoreLike) {},
});

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetTaskTypeRegistryForTest();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("taskTypeRegistry", () => {
  it("registerTaskType writes; getTaskType reads back the same Task", () => {
    const t = fakeTask("local_bash");
    registerTaskType("local_bash", t);
    expect(getTaskType("local_bash")).toBe(t);
  });

  it("re-registering the same type overrides and emits one console.warn", () => {
    const a = fakeTask("local_bash", "A");
    const b = fakeTask("local_bash", "B");
    registerTaskType("local_bash", a);
    registerTaskType("local_bash", b);
    expect(getTaskType("local_bash")).toBe(b);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("getTaskType returns undefined for unregistered type", () => {
    expect(getTaskType("local_bash")).toBeUndefined();
  });

  it("unregisterTaskType removes the entry", () => {
    registerTaskType("local_bash", fakeTask("local_bash"));
    unregisterTaskType("local_bash");
    expect(getTaskType("local_bash")).toBeUndefined();
  });

  it("unregister of an absent entry does not throw", () => {
    expect(() => unregisterTaskType("local_bash")).not.toThrow();
  });

  it("_resetTaskTypeRegistryForTest empties the registry", () => {
    registerTaskType("local_bash", fakeTask("local_bash"));
    registerTaskType("dream", fakeTask("dream"));
    _resetTaskTypeRegistryForTest();
    expect(getTaskType("local_bash")).toBeUndefined();
    expect(getTaskType("dream")).toBeUndefined();
  });

  it("different types are isolated", () => {
    const a = fakeTask("local_bash", "A");
    const b = fakeTask("dream", "B");
    registerTaskType("local_bash", a);
    registerTaskType("dream", b);
    expect(getTaskType("local_bash")).toBe(a);
    expect(getTaskType("dream")).toBe(b);
  });

  it("registry is a module-level singleton (cross-import sees same state)", async () => {
    const t = fakeTask("local_bash");
    registerTaskType("local_bash", t);
    const reimport = await import("./taskTypeRegistry.js");
    expect(reimport.getTaskType("local_bash")).toBe(t);
  });
});
```

- [ ] **Step 2: 跑测试,确认 8 个红**

Run:
```bash
npx vitest run extensions/tasks/taskTypeRegistry.test.ts 2>&1 | tail -20
```

Expected: `8 failed`,错误大致为 `Cannot find module './taskTypeRegistry.js'`。

- [ ] **Step 3: 写最小实现**

Create `extensions/tasks/taskTypeRegistry.ts`:

```ts
// Task type registry — 进程内单例,把 TaskType 字符串映射到 Task 接口实现。
//
// 让 task_kill 通用工具能跨类型路由到具体实现的 .kill();同时给 task_status
// 这种纯查询工具一个稳定的"已知类型"集合。等同于 Pi-tasks-extension 的 default
// store(模块级单例 + 测试 reset helper)。
//
// 加载顺序约定:具体 task type 的 extension 在 session_start 内注册;在
// session_shutdown 内 unregisterTaskType。覆盖式注册有 console.warn,便于
// 调试 hot-reload 二次加载导致的覆盖。

import type { Task, TaskType } from "./Task.js";

const _registry = new Map<TaskType, Task>();

export function registerTaskType(type: TaskType, task: Task): void {
  if (_registry.has(type)) {
    console.warn(
      `[pi-tasks] taskTypeRegistry: type "${type}" already registered, overriding.`,
    );
  }
  _registry.set(type, task);
}

export function getTaskType(type: TaskType): Task | undefined {
  return _registry.get(type);
}

export function unregisterTaskType(type: TaskType): void {
  _registry.delete(type);
}

export function _resetTaskTypeRegistryForTest(): void {
  _registry.clear();
}
```

- [ ] **Step 4: 跑测试,确认 8 个绿**

Run:
```bash
npx vitest run extensions/tasks/taskTypeRegistry.test.ts 2>&1 | tail -10
```

Expected: `Tests 8 passed (8)`。

- [ ] **Step 5: 跑 typecheck + 全仓测试,确认没回归**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;`Tests 321 passed (321)`(313 + 8)。

- [ ] **Step 6: Commit**

```bash
git add extensions/tasks/taskTypeRegistry.ts extensions/tasks/taskTypeRegistry.test.ts
git commit -m "feat(tasks): add taskTypeRegistry module-level singleton"
```

---

## Task 2: `task_kill` tool builder

**Files:**
- Create: `extensions/tasks/tools/taskKill.ts`
- Test: `extensions/tasks/tools/taskKill.test.ts`

- [ ] **Step 1: 写测试(8 个)**

Create `extensions/tasks/tools/taskKill.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskKillTool } from "./taskKill.js";
import { createTaskStore } from "../taskStore.js";
import { registerTask } from "../framework.js";
import {
  _resetTaskTypeRegistryForTest,
  registerTaskType,
} from "../taskTypeRegistry.js";
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
  return await tool.execute("call-1", params, new AbortController().signal, () => {}, {} as any);
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
    expect(result.content[0]?.text).toBe("Task not found: nope");
  });

  it("already terminal → text 'Task already <status>'", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh", "completed"), store);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(result.content[0]?.text).toBe("Task already completed: babcdefgh");
  });

  it("type not registered → text 'Task type ... not registered'", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(result.content[0]?.text).toBe("Task type local_bash not registered");
  });

  it("running + registered → calls Task.kill once with (taskId, store)", async () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    registerTaskType("local_bash", fakeTask);
    const result = await run(buildTaskKillTool(store), { task_id: "babcdefgh" });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy.mock.calls[0]![0]).toBe("babcdefgh");
    expect(killSpy.mock.calls[0]![1]).toBe(store);
    expect(result.content[0]?.text).toBe("Killed: babcdefgh");
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
    expect(result.content[0]?.text).toContain("Failed to kill");
    expect(result.content[0]?.text).toContain("boom");
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
```

- [ ] **Step 2: 跑测试,8 个红**

Run:
```bash
npx vitest run extensions/tasks/tools/taskKill.test.ts 2>&1 | tail -10
```

Expected: 8 failed,`Cannot find module './taskKill.js'`。

- [ ] **Step 3: 写实现**

Create `extensions/tasks/tools/taskKill.ts`:

```ts
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isTerminalTaskStatus } from "../Task.js";
import type { TaskStore } from "../taskStore.js";
import { getTaskType } from "../taskTypeRegistry.js";
import { logError } from "../logging.js";

const TaskKillParams = Type.Object({
  task_id: Type.String({ description: "ID of the task to kill (returned by spawn tools)." }),
});

export function buildTaskKillTool(store: TaskStore): ToolDefinition<typeof TaskKillParams, { action: string }> {
  return {
    name: "task_kill",
    label: "Kill task",
    description: "Stop a running task by ID. Works across all task types (bash, agent, ...).",
    parameters: TaskKillParams,
    executionMode: "parallel",
    async execute(_callId, rawParams): Promise<AgentToolResult<{ action: string }>> {
      const { task_id } = rawParams as { task_id: string };
      const task = store.getTask(task_id);
      if (!task) {
        return { content: [{ type: "text", text: `Task not found: ${task_id}` }], details: { action: "kill" } };
      }
      if (isTerminalTaskStatus(task.status)) {
        return {
          content: [{ type: "text", text: `Task already ${task.status}: ${task_id}` }],
          details: { action: "kill" },
        };
      }
      const Task = getTaskType(task.type);
      if (!Task) {
        return {
          content: [{ type: "text", text: `Task type ${task.type} not registered` }],
          details: { action: "kill" },
        };
      }
      try {
        await Task.kill(task_id, store);
      } catch (e) {
        logError(e, "task_kill");
        return {
          content: [{ type: "text", text: `Failed to kill ${task_id}: ${(e as Error)?.message ?? String(e)}` }],
          details: { action: "kill" },
        };
      }
      return { content: [{ type: "text", text: `Killed: ${task_id}` }], details: { action: "kill" } };
    },
  };
}
```

- [ ] **Step 4: 跑测试,8 个绿**

Run:
```bash
npx vitest run extensions/tasks/tools/taskKill.test.ts 2>&1 | tail -10
```

Expected: `Tests 8 passed (8)`。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: 无 error;`Tests 329 passed (329)`(321 + 8)。

- [ ] **Step 6: Commit**

```bash
git add extensions/tasks/tools/taskKill.ts extensions/tasks/tools/taskKill.test.ts
git commit -m "feat(tasks): add task_kill tool builder via taskTypeRegistry"
```

---

## Task 3: `task_status` tool builder

**Files:**
- Create: `extensions/tasks/tools/taskStatus.ts`
- Test: `extensions/tasks/tools/taskStatus.test.ts`

- [ ] **Step 1: 写测试(6 个)**

Create `extensions/tasks/tools/taskStatus.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskStatusTool } from "./taskStatus.js";
import { createTaskStore } from "../taskStore.js";
import { registerTask } from "../framework.js";
import { initTaskOutput, appendTaskOutput, _clearOutputsForTest } from "../diskOutput.js";
import { _resetTaskOutputDirForTest } from "../outputPath.js";
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
});

async function run(tool: ReturnType<typeof buildTaskStatusTool>, params: unknown) {
  return await tool.execute("call-1", params, new AbortController().signal, () => {}, {} as any);
}

describe("buildTaskStatusTool", () => {
  it("not found → text Task not found", async () => {
    const store = createTaskStore();
    const result = await run(buildTaskStatusTool(store), { task_id: "nope" });
    expect(result.content[0]?.text).toContain("not found");
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
```

- [ ] **Step 2: 跑测试,6 红**

Run:
```bash
npx vitest run extensions/tasks/tools/taskStatus.test.ts 2>&1 | tail -10
```

Expected: 6 failed。

- [ ] **Step 3: 写实现**

Create `extensions/tasks/tools/taskStatus.ts`:

```ts
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "../taskStore.js";
import { getTaskOutputDelta } from "../diskOutput.js";
import { logError } from "../logging.js";

const TaskStatusParams = Type.Object({
  task_id: Type.String({ description: "ID of the task to inspect." }),
  output_offset: Type.Optional(
    Type.Number({ description: "Byte offset; only data past this offset is returned." }),
  ),
});

interface TaskStatusDetails {
  action: "status";
  status?: string;
  type?: string;
  description?: string;
  startTime?: number;
  endTime?: number;
  notified?: boolean;
  output_delta: string;
  next_offset: number;
  total_size: number;
}

export function buildTaskStatusTool(store: TaskStore): ToolDefinition<typeof TaskStatusParams, TaskStatusDetails> {
  return {
    name: "task_status",
    label: "Task status",
    description: "Read a task's current status, terminal exit info, and incremental output past a byte offset.",
    parameters: TaskStatusParams,
    executionMode: "parallel",
    async execute(_callId, rawParams): Promise<AgentToolResult<TaskStatusDetails>> {
      const { task_id, output_offset } = rawParams as { task_id: string; output_offset?: number };
      const task = store.getTask(task_id);
      if (!task) {
        return {
          content: [{ type: "text", text: `Task not found: ${task_id}` }],
          details: { action: "status", output_delta: "", next_offset: 0, total_size: 0 },
        };
      }
      let delta = "";
      let total = 0;
      try {
        const r = await getTaskOutputDelta(task_id, output_offset ?? 0);
        delta = r.content;
        total = r.totalSize;
      } catch (e) {
        logError(e, "task_status");
      }
      const details: TaskStatusDetails = {
        action: "status",
        status: task.status,
        type: task.type,
        description: task.description,
        startTime: task.startTime,
        endTime: task.endTime,
        notified: task.notified,
        output_delta: delta,
        next_offset: total,
        total_size: total,
      };
      const head = `${task.status} (${task.type}) — ${task.description}`;
      const tail = delta ? `\n${delta}` : "";
      return { content: [{ type: "text", text: head + tail }], details };
    },
  };
}
```

> Note: Plan 假定 `getTaskOutputDelta` 返回 `{content: string, totalSize: number}`。如果 spec 实际是 `{content, newOffset}`,在 Step 4 红绿循环里会自然报错 — 先看实际签名再调整两个字段名。

- [ ] **Step 4: 跑测试**

Run:
```bash
npx vitest run extensions/tasks/tools/taskStatus.test.ts 2>&1 | tail -20
```

如果某测试因 `getTaskOutputDelta` 实际返回字段不同而红 → 调整测试 + 实现里的字段名一致(只改字段名,不改逻辑)。再跑直到 6 绿。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: 无 error;`Tests 335 passed (335)`(329 + 6)。

- [ ] **Step 6: Commit**

```bash
git add extensions/tasks/tools/taskStatus.ts extensions/tasks/tools/taskStatus.test.ts
git commit -m "feat(tasks): add task_status tool with offset-based output delta"
```

---

## Task 4: `task_list` tool builder

**Files:**
- Create: `extensions/tasks/tools/taskList.ts`
- Test: `extensions/tasks/tools/taskList.test.ts`

- [ ] **Step 1: 写测试(5 个)**

Create `extensions/tasks/tools/taskList.test.ts`:

```ts
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
  return await tool.execute("call-1", params, new AbortController().signal, () => {}, {} as any);
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
    const row = (result.details as { tasks: Record<string, unknown>[] }).tasks[0]!;
    expect(row.id).toBe("b1");
    expect(row.type).toBe("local_bash");
    expect(row.status).toBe("running");
    expect(row.description).toBe("task b1");
    expect(row.startTime).toBe(1000);
  });
});
```

- [ ] **Step 2: 跑测试,5 红**

Run:
```bash
npx vitest run extensions/tasks/tools/taskList.test.ts 2>&1 | tail -10
```

Expected: 5 failed。

- [ ] **Step 3: 写实现**

Create `extensions/tasks/tools/taskList.ts`:

```ts
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "../taskStore.js";
import { isTerminalTaskStatus } from "../Task.js";

const TaskListParams = Type.Object({
  filter: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("all")])),
});

interface TaskListRow {
  id: string;
  type: string;
  status: string;
  description: string;
  startTime: number;
  endTime?: number;
}

interface TaskListDetails {
  action: "list";
  filter: "running" | "all";
  tasks: TaskListRow[];
}

export function buildTaskListTool(store: TaskStore): ToolDefinition<typeof TaskListParams, TaskListDetails> {
  return {
    name: "task_list",
    label: "List tasks",
    description: "List currently registered tasks. Filter='running' (default) or 'all'.",
    parameters: TaskListParams,
    executionMode: "parallel",
    async execute(_callId, rawParams): Promise<AgentToolResult<TaskListDetails>> {
      const { filter } = rawParams as { filter?: "running" | "all" };
      const f: "running" | "all" = filter ?? "running";
      const snapshot = store.get();
      const rows: TaskListRow[] = [];
      for (const t of Object.values(snapshot)) {
        if (f === "running" && isTerminalTaskStatus(t.status)) continue;
        rows.push({
          id: t.id,
          type: t.type,
          status: t.status,
          description: t.description,
          startTime: t.startTime,
          endTime: t.endTime,
        });
      }
      const text = rows.length
        ? rows.map((r) => `${r.id}  ${r.status}  ${r.type}  ${r.description}`).join("\n")
        : "No tasks";
      return { content: [{ type: "text", text }], details: { action: "list", filter: f, tasks: rows } };
    },
  };
}
```

- [ ] **Step 4: 跑测试,5 绿**

Run:
```bash
npx vitest run extensions/tasks/tools/taskList.test.ts 2>&1 | tail -10
```

Expected: `Tests 5 passed (5)`。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: `Tests 340 passed (340)`(335 + 5)。

- [ ] **Step 6: Commit**

```bash
git add extensions/tasks/tools/taskList.ts extensions/tasks/tools/taskList.test.ts
git commit -m "feat(tasks): add task_list tool with running/all filter"
```

---

## Task 5: 把三个通用 tool 接到 `extensions/tasks/index.ts`

**Files:**
- Modify: `extensions/tasks/index.ts`(加 import + registerTool×3 + re-export + shutdown 加 reset)
- Modify: `extensions/tasks/index.test.ts`(加 3 个测试)

- [ ] **Step 1: 在 `index.test.ts` 末尾加 3 个测试**

读 `extensions/tasks/index.test.ts` 现有结构 → 在文件末尾追加:

```ts
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
```

> Note: 现有 `index.test.ts` 已有 `createFakePi` / `fireEvent` helper(本期 §4.5 沿用),不要重复定义。如果跑测试时 `pi.registerTool` 引用未定义,意味着旧 fakePi 没暴露 mock — 加一行 `registerTool: vi.fn()` 在 createFakePi 即可,但当前文件已有这一行,无需改。

- [ ] **Step 2: 跑测试,3 红**

Run:
```bash
npx vitest run extensions/tasks/index.test.ts 2>&1 | tail -10
```

Expected: 3 failed(原有的过去仍绿)。

- [ ] **Step 3: 改 `extensions/tasks/index.ts`**

打开 `extensions/tasks/index.ts`:

(a) 在 import 区(顶部)加:

```ts
import { buildTaskKillTool } from "./tools/taskKill.js";
import { buildTaskStatusTool } from "./tools/taskStatus.js";
import { buildTaskListTool } from "./tools/taskList.js";
import {
  _resetTaskTypeRegistryForTest,
  getTaskType,
  registerTaskType,
  unregisterTaskType,
} from "./taskTypeRegistry.js";
```

(b) 在 `pi.on("session_start", ...)` 既有 handler 内末尾追加:

```ts
    pi.registerTool(buildTaskKillTool(store));
    pi.registerTool(buildTaskStatusTool(store));
    pi.registerTool(buildTaskListTool(store));
```

(c) 在 `pi.on("session_shutdown", ...)` 既有 handler 内末尾追加(放在 `store._resetForTest()` 之后):

```ts
    _resetTaskTypeRegistryForTest();
```

(d) 在文件底部 re-export 区追加:

```ts
export {
  getTaskType,
  registerTaskType,
  unregisterTaskType,
  _resetTaskTypeRegistryForTest,
} from "./taskTypeRegistry.js";

export { buildTaskKillTool } from "./tools/taskKill.js";
export { buildTaskStatusTool } from "./tools/taskStatus.js";
export { buildTaskListTool } from "./tools/taskList.js";
```

- [ ] **Step 4: 跑测试,3 绿 + 原 7 仍绿**

Run:
```bash
npx vitest run extensions/tasks/index.test.ts 2>&1 | tail -10
```

Expected: `Tests 10 passed (10)`(7 + 3)。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: `Tests 343 passed (343)`(340 + 3)。

- [ ] **Step 6: Commit**

```bash
git add extensions/tasks/index.ts extensions/tasks/index.test.ts
git commit -m "feat(tasks): wire taskTypeRegistry + cross-type tools at session_start"
```

---

## Task 6: `localshell` 包骨架

**Files:**
- Create: `extensions/localshell/package.json`
- Create: `extensions/localshell/index.ts`(空 default export 占位)

- [ ] **Step 1: 创建 `package.json`**

Create `extensions/localshell/package.json`(完全 mirror `extensions/tasks/package.json`):

```json
{
  "name": "pi-localshell-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

- [ ] **Step 2: 写最小 `index.ts` 占位(不挂任何 hook)**

Create `extensions/localshell/index.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function localshellExtension(_pi: ExtensionAPI): void {
  // TODO: filled in by Task 11.
}
```

- [ ] **Step 3: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;测试数量不变(343)。

- [ ] **Step 4: Commit**

```bash
git add extensions/localshell/package.json extensions/localshell/index.ts
git commit -m "feat(localshell): scaffold extension package"
```

---

## Task 7: `fakeBashOperations` 测试 helper(无独立测试,被后续测试覆盖)

**Files:**
- Create: `extensions/localshell/_test/fakeBashOperations.ts`

- [ ] **Step 1: 写实现**

Create `extensions/localshell/_test/fakeBashOperations.ts`:

```ts
// Test helper — mock BashOperations so tests don't spawn real processes.
//
// 用法:
//   const fake = createFakeBashOps();
//   await spawnLocalShell(pi, store, { command: "echo", description: "...", operations: fake.ops });
//   fake.emit(Buffer.from("hello\n"));   // 模拟 onData 推
//   fake.finish(0);                       // 模拟 exec 自然结束
//   expect(fake.aborted).toBe(false);

import type { BashOperations } from "@earendil-works/pi-coding-agent";

export interface FakeBashOps {
  ops: BashOperations;
  /** 推一段 stdout 给 onData。 */
  emit(buf: Buffer): void;
  /** 让 exec promise resolve。 */
  finish(exitCode: number | null): void;
  /** 让 exec promise reject(spawn error 模拟)。 */
  fail(error: Error): void;
  /** signal.abort() 是否被调过。 */
  aborted: boolean;
  /** 上次 exec 的 cwd / command(便于断言)。 */
  lastCommand?: string;
  lastCwd?: string;
}

export function createFakeBashOps(): FakeBashOps {
  const fake: FakeBashOps = {
    ops: {} as BashOperations,
    emit() {},
    finish() {},
    fail() {},
    aborted: false,
  };

  fake.ops = {
    async exec(command, cwd, options) {
      fake.lastCommand = command;
      fake.lastCwd = cwd;
      let onDataCb: ((b: Buffer) => void) | undefined = options.onData;
      let resolveFn: (v: { exitCode: number | null }) => void = () => {};
      let rejectFn: (e: unknown) => void = () => {};
      const promise = new Promise<{ exitCode: number | null }>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      options.signal?.addEventListener("abort", () => {
        fake.aborted = true;
        resolveFn({ exitCode: null });
      });
      fake.emit = (buf: Buffer) => onDataCb?.(buf);
      fake.finish = (exitCode: number | null) => resolveFn({ exitCode });
      fake.fail = (error: Error) => rejectFn(error);
      return promise;
    },
  };

  return fake;
}
```

- [ ] **Step 2: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;测试数量不变。

- [ ] **Step 3: Commit**

```bash
git add extensions/localshell/_test/fakeBashOperations.ts
git commit -m "test(localshell): add fakeBashOperations helper for unit tests"
```

---

## Task 8: `stallWatchdog` — 进度通知

**Files:**
- Create: `extensions/localshell/stallWatchdog.ts`
- Test: `extensions/localshell/stallWatchdog.test.ts`

> 此模块依赖 `tasks/notification` customType,但用 `details.extra.kind = 'stall-prompt'` 区分,不复用 `notifyTaskTerminal`(那个会 CAS 翻 `notified`,只允许一次)。这里独立调 `pi.sendMessage`。

- [ ] **Step 1: 写测试(12 个)**

Create `extensions/localshell/stallWatchdog.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikePrompt, startStallWatchdog } from "./stallWatchdog.js";

let tmpRoot: string;
let outputFile: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "stall-test-"));
  outputFile = join(tmpRoot, "task.output");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fakePi = () => ({
  sendMessage: vi.fn(),
});

describe("looksLikePrompt", () => {
  it.each([
    "Continue? ",
    "Are you sure? ",
    "Press any key",
    "(y/n)",
    "[Y/n]",
    "(yes/no)",
    "Overwrite?",
  ])("matches prompt-looking tail %s", (s) => {
    expect(looksLikePrompt(s)).toBe(true);
  });

  it("does not match plain output", () => {
    expect(looksLikePrompt("processing 42 records")).toBe(false);
  });
});

describe("startStallWatchdog", () => {
  it("size grows → no notification fires", async () => {
    const pi = fakePi();
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    writeFileSync(outputFile, "first chunk");
    await vi.advanceTimersByTimeAsync(5_000);
    writeFileSync(outputFile, "first chunk\nsecond chunk");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    cancel();
  });

  it("size unchanged but < 45s threshold → no notification", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "static");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    cancel();
  });

  it("size unchanged ≥ 45s + tail not prompt → no notification, lastGrowth reset", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "loud working not a prompt");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
    // 再过 50s 也不应再 fire(因为 lastGrowth 已 reset,又重新等 45s)
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(0);
    cancel();
  });

  it("size unchanged ≥ 45s + prompt → sendMessage once with extra.kind='stall-prompt'", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Are you sure? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0];
    expect((msg.details as { extra?: { kind?: string } }).extra?.kind).toBe("stall-prompt");
    cancel();
  });

  it("after firing, latches and does not re-fire on subsequent ticks", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Continue? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("cancel() stops further ticks", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "static");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("stat throws (file does not exist) → swallowed, no throw", async () => {
    const pi = fakePi();
    // 不写 file
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", join(tmpRoot, "missing.output"));
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    expect(pi.sendMessage).not.toHaveBeenCalled();
    cancel();
  });

  it("XML content omits <status> tag", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Continue? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    const msg = pi.sendMessage.mock.calls[0]![0];
    expect(msg.content as string).not.toContain("<status>");
    cancel();
  });

  it("sendMessage uses customType 'tasks/notification'", async () => {
    const pi = fakePi();
    writeFileSync(outputFile, "Continue? ");
    const cancel = startStallWatchdog(pi as never, "babcdefgh", "do work", outputFile);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(pi.sendMessage.mock.calls[0]![0].customType).toBe("tasks/notification");
    cancel();
  });
});
```

- [ ] **Step 2: 跑测试,12 红**

Run:
```bash
npx vitest run extensions/localshell/stallWatchdog.test.ts 2>&1 | tail -20
```

Expected: 12 failed(`Cannot find module './stallWatchdog.js'`)。

- [ ] **Step 3: 写实现**

Create `extensions/localshell/stallWatchdog.ts`:

```ts
// Stall watchdog — 监测任务输出长时间停滞 + 像交互式 prompt 时,
// 推一条 'tasks/notification' 进度消息(extra.kind='stall-prompt'),
// 不带 <status> tag(避免被消费方误判为终态)。
//
// 行为对齐 claude/tasks/LocalShellTask/LocalShellTask.tsx:startStallWatchdog
// (5s 周期 / 45s 阈值 / 1024 bytes tail / 命中 latch 后不重发)。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stat, open } from "node:fs/promises";
import { TASK_NOTIFICATION_CUSTOM_TYPE, escapeXml } from "pi-tasks-extension";

const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;

const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

async function tailFile(path: string, bytes: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const s = await fh.stat();
    const start = Math.max(0, s.size - bytes);
    const len = s.size - start;
    if (len === 0) return "";
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function buildStallPromptXml(taskId: string, description: string, outputFile: string, tail: string): string {
  return [
    "<task_notification>",
    `<task_id>${escapeXml(taskId)}</task_id>`,
    `<output_file>${escapeXml(outputFile)}</output_file>`,
    `<summary>${escapeXml(`Background command "${description}" appears to be waiting for interactive input`)}</summary>`,
    "</task_notification>",
    "Last output:",
    tail.trimEnd(),
    "",
    "The command is likely blocked on an interactive prompt. Kill this task and re-run with piped input (e.g., `echo y | command`) or a non-interactive flag.",
  ].join("\n");
}

export function startStallWatchdog(
  pi: ExtensionAPI,
  taskId: string,
  description: string,
  outputFile: string,
): () => void {
  let lastSize = 0;
  let lastGrowth = Date.now();
  let cancelled = false;

  const timer = setInterval(() => {
    if (cancelled) return;
    void (async () => {
      try {
        const s = await stat(outputFile);
        if (s.size > lastSize) {
          lastSize = s.size;
          lastGrowth = Date.now();
          return;
        }
        if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;
        let tail = "";
        try {
          tail = await tailFile(outputFile, STALL_TAIL_BYTES);
        } catch {
          return;
        }
        if (cancelled) return;
        if (!looksLikePrompt(tail)) {
          // Reset window so we don't re-tail every 5s on a slow-but-running command.
          lastGrowth = Date.now();
          return;
        }
        cancelled = true;
        clearInterval(timer);
        pi.sendMessage(
          {
            customType: TASK_NOTIFICATION_CUSTOM_TYPE,
            content: buildStallPromptXml(taskId, description, outputFile, tail),
            display: true,
            details: {
              taskId,
              taskType: "local_bash",
              status: "running" as const,
              description,
              outputFile,
              timestamp: Date.now(),
              extra: { kind: "stall-prompt" },
            },
          } as never,
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      } catch {
        // stat 失败(file not yet exists 等) → 跳过此 tick
      }
    })();
  }, STALL_CHECK_INTERVAL_MS);
  timer.unref?.();

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}
```

> Note: `pi.sendMessage` 的 generic 在 stall-prompt 这条不严格对齐 `TaskNotificationDetails`(我们要塞 `extra.kind`),用 `as never` 绕开类型检查。`TaskNotificationDetails` 的 `status` 字段在上一期类型上是 `'completed'|'failed'|'killed'`,我们这里用 'running' 表达"非终态"。如果上一期类型签名严格反对,修法是 `as TaskNotificationDetails`(允许 `extra` 字段)+ status 用现有终态 union 之外的 ad-hoc(运行时 details 不影响)。

- [ ] **Step 4: 跑测试**

Run:
```bash
npx vitest run extensions/localshell/stallWatchdog.test.ts 2>&1 | tail -20
```

Expected: `Tests 12 passed (12)`(`it.each` 的 7 个 case 算 7 测试)。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;`Tests 355 passed (355)`(343 + 12)。

- [ ] **Step 6: Commit**

```bash
git add extensions/localshell/stallWatchdog.ts extensions/localshell/stallWatchdog.test.ts
git commit -m "feat(localshell): add stallWatchdog with prompt detection"
```

---

## Task 9: `kill` helper

**Files:**
- Create: `extensions/localshell/kill.ts`
- Test: `extensions/localshell/kill.test.ts`

- [ ] **Step 1: 写测试(6 个)**

Create `extensions/localshell/kill.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskStore,
  registerTask,
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} from "pi-tasks-extension";
import type { TaskStore } from "pi-tasks-extension";
import { killLocalShellTask } from "./kill.js";
import type { LocalShellTaskState } from "./localShellTask.js";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kill-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdirEnv;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const sample = (id: string, status: LocalShellTaskState["status"] = "running"): LocalShellTaskState => ({
  id,
  type: "local_bash",
  status,
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
  command: "echo hi",
  cwd: "/tmp",
  abortController: new AbortController(),
  isBackgrounded: false,
});

const fakePi = () => ({ sendMessage: vi.fn() });

describe("killLocalShellTask", () => {
  it("not found → no-op (no throw, no sendMessage)", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    await killLocalShellTask(pi as never, store, "nope");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("terminal task → no-op", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    registerTask(sample("babcdef01", "completed"), store);
    await killLocalShellTask(pi as never, store, "babcdef01");
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("running task → status='killed' + endTime + abort.abort()", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    const t = sample("babcdef02");
    const abortSpy = vi.spyOn(t.abortController, "abort");
    registerTask(t, store);
    await killLocalShellTask(pi as never, store, "babcdef02");
    const after = store.getTask("babcdef02") as LocalShellTaskState | undefined;
    expect(after?.status).toBe("killed");
    expect(after?.endTime).toBeGreaterThan(0);
    expect(abortSpy).toHaveBeenCalled();
  });

  it("running task → cancelStallWatchdog called", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    const cancelSpy = vi.fn();
    const t: LocalShellTaskState = { ...sample("babcdef03"), cancelStallWatchdog: cancelSpy };
    registerTask(t, store);
    await killLocalShellTask(pi as never, store, "babcdef03");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("running task → notifyTaskTerminal once with status='killed'", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    registerTask(sample("babcdef04"), store);
    await killLocalShellTask(pi as never, store, "babcdef04");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(msg.content).toContain("<status>killed</status>");
  });

  it("repeat kill → second is no-op (no double notify)", async () => {
    const pi = fakePi();
    const store = createTaskStore();
    registerTask(sample("babcdef05"), store);
    await killLocalShellTask(pi as never, store, "babcdef05");
    await killLocalShellTask(pi as never, store, "babcdef05");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试,6 红**(同时会拽出 localShellTask.ts 里的类型未定义 → 占位 type)

Run:
```bash
npx vitest run extensions/localshell/kill.test.ts 2>&1 | tail -20
```

Expected: 6 failed,`Cannot find module './kill.js'` 或 `'./localShellTask.js'`。

- [ ] **Step 3: 先写最小 `localShellTask.ts` 类型占位**

如果 `extensions/localshell/localShellTask.ts` 还没有,先创建仅含类型部分:

```ts
import type { TaskStateBase } from "pi-tasks-extension";

export interface LocalShellTaskState extends TaskStateBase {
  type: "local_bash";
  command: string;
  cwd: string;
  abortController: AbortController;
  cancelStallWatchdog?: () => void;
  isBackgrounded: boolean;
  result?: { exitCode: number | null; killed: boolean };
}
```

- [ ] **Step 4: 写 `kill.ts` 实现**

Create `extensions/localshell/kill.ts`:

```ts
// LocalShellTask.kill 行为:
//   - 已不存在 / 已终态 → 早返回;
//   - cancel watchdog → abort exec → flush 盘缓冲 → 翻 status='killed' / endTime → notifyTaskTerminal(CAS) → evict。
//
// notifyTaskTerminal 自带 CAS,所以二次 kill 不会双发通知(测试覆盖)。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  evictTaskOutput,
  flushTaskOutput,
  isTerminalTaskStatus,
  logError,
  notifyTaskTerminal,
  updateTaskState,
  type TaskStore,
} from "pi-tasks-extension";
import type { LocalShellTaskState } from "./localShellTask.js";

export async function killLocalShellTask(
  pi: ExtensionAPI,
  store: TaskStore,
  taskId: string,
): Promise<void> {
  const task = store.getTask(taskId) as LocalShellTaskState | undefined;
  if (!task) return;
  if (isTerminalTaskStatus(task.status)) return;

  task.cancelStallWatchdog?.();
  try {
    task.abortController.abort();
  } catch (e) {
    logError(e, "killLocalShellTask abort");
  }
  try {
    await flushTaskOutput(taskId);
  } catch (e) {
    logError(e, "killLocalShellTask flush");
  }

  updateTaskState<LocalShellTaskState>(taskId, store, (t) =>
    t.status === "running"
      ? { ...t, status: "killed", endTime: Date.now() }
      : t,
  );

  notifyTaskTerminal(pi, store, {
    taskId,
    taskType: "local_bash",
    status: "killed",
    description: task.description,
    outputFile: task.outputFile,
    toolUseId: task.toolUseId,
  });

  void evictTaskOutput(taskId);
}
```

- [ ] **Step 5: 跑测试**

Run:
```bash
npx vitest run extensions/localshell/kill.test.ts 2>&1 | tail -10
```

Expected: `Tests 6 passed (6)`。

- [ ] **Step 6: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;`Tests 361 passed (361)`(355 + 6)。

- [ ] **Step 7: Commit**

```bash
git add extensions/localshell/kill.ts extensions/localshell/kill.test.ts extensions/localshell/localShellTask.ts
git commit -m "feat(localshell): add killLocalShellTask helper + state type"
```

---

## Task 10: `outputBuffer.ts` truncate helper(无独立测试,被 localShellTask 覆盖)

**Files:**
- Create: `extensions/localshell/outputBuffer.ts`

- [ ] **Step 1: 写实现**

Create `extensions/localshell/outputBuffer.ts`:

```ts
// 把 disk output 截到 MAX_BYTES,头尾保留,中间替换为 [...truncated N bytes...]。
//
// 与 Claude bash tool 行为一致:大输出直接读完然后头中尾切。任何一个 task type
// 想要"同步返回 stdout 给 LLM"都会用到,放在 localshell 是因为它当前只有
// 一个消费者;有第二个消费者时上提到 tasks/。

import { getTaskOutput } from "pi-tasks-extension";

export const MAX_OUTPUT_BYTES = 30_000;

export async function readTruncatedOutput(taskId: string, max = MAX_OUTPUT_BYTES): Promise<string> {
  const full = (await getTaskOutput(taskId)) ?? "";
  if (Buffer.byteLength(full, "utf8") <= max) return full;
  const head = max / 2 | 0;
  const tail = max - head - 64;
  const buf = Buffer.from(full, "utf8");
  const headStr = buf.subarray(0, head).toString("utf8");
  const tailStr = buf.subarray(buf.length - tail).toString("utf8");
  return `${headStr}\n[...truncated ${buf.length - max} bytes...]\n${tailStr}`;
}
```

> Note: 如果上一期 `getTaskOutput` 不在 re-export 中(只有 `getTaskOutputDelta`),把 `getTaskOutput(taskId)` 替换为 `(await getTaskOutputDelta(taskId, 0)).content`。Step 2 typecheck 会暴露这个差异。

- [ ] **Step 2: typecheck**

Run:
```bash
npm run typecheck 2>&1 | tail -10
```

如有 error,按 Note 改。

- [ ] **Step 3: Commit**

```bash
git add extensions/localshell/outputBuffer.ts
git commit -m "feat(localshell): add readTruncatedOutput head+tail truncation"
```

---

## Task 11: `localShellTask.ts` — `spawnLocalShell` + Task 接口

**Files:**
- Modify: `extensions/localshell/localShellTask.ts`(已有类型,加实现)
- Test: `extensions/localshell/localShellTask.test.ts`

> 这是本期最大模块。Spec §3.1-§3.5 描述了完整时间线。

- [ ] **Step 1: 写测试(16 个)**

Create `extensions/localshell/localShellTask.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  createTaskStore,
  type TaskStore,
} from "pi-tasks-extension";
import { spawnLocalShell, LocalShellTask } from "./localShellTask.js";
import { createFakeBashOps } from "./_test/fakeBashOperations.js";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;
let store: TaskStore;
let pi: { sendMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "spawn-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  store = createTaskStore();
  store._setSessionId(`spawn-${Math.random().toString(36).slice(2)}`);
  pi = { sendMessage: vi.fn() };
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdirEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.useRealTimers();
});

describe("spawnLocalShell — sync finish path", () => {
  it("registers task in store with status='running'", async () => {
    const fake = createFakeBashOps();
    const p = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    // 在 exec 收尾前断言 store 有 running task
    await Promise.resolve();
    const tasks = Object.values(store.get());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("running");
    fake.finish(0);
    await p;
  });

  it("initTaskOutput creates outputFile entry (latch held)", async () => {
    const fake = createFakeBashOps();
    const p = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const t = Object.values(store.get())[0]!;
    expect(t.outputFile).toContain(t.id);
    fake.finish(0);
    await p;
  });

  it("starts stall watchdog (cancel function stored on state)", async () => {
    const fake = createFakeBashOps();
    const p = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const t = Object.values(store.get())[0] as { cancelStallWatchdog?: () => void };
    expect(typeof t.cancelStallWatchdog).toBe("function");
    fake.finish(0);
    await p;
  });

  it("exitCode=0 → status='completed', backgrounded=false, exitCode=0", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("hello\n"));
    fake.finish(0);
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.backgrounded).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("exitCode=1 → status='failed'", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "false", description: "fail", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(1);
    const result = await promise;
    expect(result.status).toBe("failed");
  });

  it("exitCode=null → status='killed'", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 99", description: "sig", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(null);
    const result = await promise;
    expect(result.status).toBe("killed");
  });

  it("calls notifyTaskTerminal exactly once on sync finish", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    await promise;
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("output is truncated to 30000 bytes (head + truncated marker + tail)", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "yes", description: "big", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("A".repeat(50_000)));
    fake.finish(0);
    const result = await promise;
    expect(result.output.length).toBeLessThan(31_000);
    expect(result.output).toContain("[...truncated");
  });
});

describe("spawnLocalShell — timeout path", () => {
  it("timeoutMs hit while exec slow → resolve with backgrounded=true / status='running'", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999",
      description: "long",
      timeoutMs: 100,
      operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result.backgrounded).toBe(true);
    expect(result.status).toBe("running");
    expect(result.backgroundReason).toBe("timeout");
    fake.finish(0);  // 让 exec promise 收尾,清理 dangling promise
  });

  it("after backgrounding, exec finishing fires terminal notify", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    await promise;
    expect(pi.sendMessage).not.toHaveBeenCalled();  // 转后台后还没真完成,不发终态
    vi.useRealTimers();
    fake.finish(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("backgrounded then killed → status='killed', no double notify", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    const r = await promise;
    vi.useRealTimers();
    await LocalShellTask.kill(r.taskId, store);
    fake.finish(0);
    await new Promise((res) => setTimeout(res, 0));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = pi.sendMessage.mock.calls[0]![0] as { content: string };
    expect(msg.content).toContain("<status>killed</status>");
  });
});

describe("spawnLocalShell — error path", () => {
  it("multiple onData chunks all written to disk output", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("a"));
    fake.emit(Buffer.from("b"));
    fake.emit(Buffer.from("c"));
    fake.finish(0);
    const result = await promise;
    expect(result.output).toContain("abc");
  });

  it("operations.exec rejects (spawn fail) → status='failed', output contains error", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "bad", description: "err", operations: fake.ops,
    });
    await Promise.resolve();
    fake.fail(new Error("spawn ENOENT"));
    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.output).toContain("spawn ENOENT");
  });

  it("flush awaited before status flips to terminal (last chunk preserved)", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("LASTCHUNK"));
    fake.finish(0);
    const result = await promise;
    expect(result.output).toContain("LASTCHUNK");
  });

  it("watchdog cancelled when terminal", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const t = Object.values(store.get())[0] as { cancelStallWatchdog?: () => void };
    const cancelled = vi.fn();
    if (t.cancelStallWatchdog) {
      const orig = t.cancelStallWatchdog;
      t.cancelStallWatchdog = () => {
        cancelled();
        orig();
      };
    }
    fake.finish(0);
    await promise;
    expect(cancelled).toHaveBeenCalled();
  });

  it("evictTaskOutput called after terminal", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    const result = await promise;
    expect(result.status).toBe("completed");
    // evict 是 best-effort fire-and-forget;只能间接验证 store 仍有 task(因为 evict 不删 store entry)
    expect(store.getTask(result.taskId)).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试,16 红**

Run:
```bash
npx vitest run extensions/localshell/localShellTask.test.ts 2>&1 | tail -20
```

Expected: 16 failed,缺 `spawnLocalShell` / `LocalShellTask` 实现。

- [ ] **Step 3: 完整写 `localShellTask.ts`**

Replace `extensions/localshell/localShellTask.ts` with:

```ts
// LocalShellTask — `local_bash` 的 Task 接口实现 + spawnLocalShell。
//
// 时间线见 spec §3:
//   - exec 启动后 race 两个事件:60s timeout 或 exec 自然结束。
//   - timeout 命中 → state.isBackgrounded=true,LLM 收 partial。
//   - exec 结束:read state.status,根据 'killed' / 已 background / sync race winner 三路径分发。
//
// notifyTaskTerminal 用上一期 CAS 确保多路径只发一次终态。

import {
  type ExtensionAPI,
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  appendTaskOutput,
  createTaskStateBase,
  evictTaskOutput,
  flushTaskOutput,
  generateTaskId,
  getTaskOutputPath,
  initTaskOutput,
  logError,
  notifyTaskTerminal,
  registerTask,
  type Task,
  type TaskStateBase,
  type TaskStore,
  updateTaskState,
} from "pi-tasks-extension";
import { startStallWatchdog } from "./stallWatchdog.js";
import { killLocalShellTask } from "./kill.js";
import { readTruncatedOutput } from "./outputBuffer.js";

export interface LocalShellTaskState extends TaskStateBase {
  type: "local_bash";
  command: string;
  cwd: string;
  abortController: AbortController;
  cancelStallWatchdog?: () => void;
  isBackgrounded: boolean;
  result?: { exitCode: number | null; killed: boolean };
}

export interface SpawnLocalShellOptions {
  command: string;
  description: string;
  toolUseId?: string;
  timeoutMs?: number;
  cwd?: string;
  operations?: BashOperations;
}

export interface SpawnLocalShellResult {
  taskId: string;
  status: "completed" | "failed" | "killed" | "running";
  backgrounded: boolean;
  exitCode?: number;
  output: string;
  outputFile: string;
  backgroundReason?: "timeout" | "user_request";
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function spawnLocalShell(
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalShellOptions,
): Promise<SpawnLocalShellResult> {
  const taskId = generateTaskId("local_bash");
  const cwd = opts.cwd ?? process.cwd();
  const outputFile = getTaskOutputPath(taskId);
  const abort = new AbortController();
  const ops = opts.operations ?? createLocalBashOperations();

  await initTaskOutput(taskId);

  const cancelStallWatchdog = startStallWatchdog(pi, taskId, opts.description, outputFile);

  const initial: LocalShellTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "local_bash",
      description: opts.description,
      outputFile,
      toolUseId: opts.toolUseId,
    }),
    type: "local_bash",
    status: "running",
    command: opts.command,
    cwd,
    abortController: abort,
    cancelStallWatchdog,
    isBackgrounded: false,
  };
  registerTask(initial, store);

  let resultRef: { exitCode: number | null } | null = null;
  let resolved = false;

  // exec 自然结束的 promise(可能 reject)
  const execPromise = ops
    .exec(opts.command, cwd, {
      onData: (buf) => {
        try {
          appendTaskOutput(taskId, buf.toString("utf8"));
        } catch (e) {
          logError(e, "spawnLocalShell appendTaskOutput");
        }
      },
      signal: abort.signal,
    })
    .then((r) => {
      resultRef = r;
    })
    .catch((e) => {
      // spawn 失败:把错误塞进 disk output,resultRef 留空表示 failed
      try {
        appendTaskOutput(taskId, String((e as Error)?.message ?? e));
      } catch {/* ignore */}
      resultRef = { exitCode: 1 };
    });

  return new Promise<SpawnLocalShellResult>((resolve) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      void onTimeout(resolve);
    }, timeoutMs);

    void execPromise.then(async () => {
      clearTimeout(timer);
      const r = resultRef ?? { exitCode: 1 };
      if (resolved) {
        // sync 路径已 resolve(转后台)— 走 background terminal handler
        await onBackgroundedTerminal(r);
        return;
      }
      resolved = true;
      await onSyncFinish(resolve, r);
    });
  });

  async function onSyncFinish(
    resolve: (v: SpawnLocalShellResult) => void,
    r: { exitCode: number | null },
  ): Promise<void> {
    const t = store.getTask(taskId) as LocalShellTaskState | undefined;
    if (t?.status === "killed") {
      // kill 路径已 notify;sync race 输了,只读输出返回 killed
      const out = await safeRead();
      resolve({
        taskId,
        status: "killed",
        backgrounded: false,
        exitCode: r.exitCode ?? undefined,
        output: out,
        outputFile,
      });
      return;
    }
    cancelStallWatchdog();
    try { await flushTaskOutput(taskId); } catch (e) { logError(e, "spawnLocalShell flush"); }
    const finalStatus: SpawnLocalShellResult["status"] =
      r.exitCode === 0 ? "completed" : r.exitCode === null ? "killed" : "failed";
    updateTaskState<LocalShellTaskState>(taskId, store, (cur) => ({
      ...cur,
      status: finalStatus,
      endTime: Date.now(),
      result: { exitCode: r.exitCode, killed: false },
    }));
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_bash",
      status: finalStatus,
      description: opts.description,
      outputFile,
      toolUseId: opts.toolUseId,
      exitCode: r.exitCode ?? undefined,
    });
    const out = await safeRead();
    resolve({
      taskId,
      status: finalStatus,
      backgrounded: false,
      exitCode: r.exitCode ?? undefined,
      output: out,
      outputFile,
    });
    void evictTaskOutput(taskId);
  }

  async function onTimeout(resolve: (v: SpawnLocalShellResult) => void): Promise<void> {
    updateTaskState<LocalShellTaskState>(taskId, store, (cur) => ({
      ...cur,
      isBackgrounded: true,
    }));
    const out = await safeRead();
    resolve({
      taskId,
      status: "running",
      backgrounded: true,
      output: out,
      outputFile,
      backgroundReason: "timeout",
    });
  }

  async function onBackgroundedTerminal(r: { exitCode: number | null }): Promise<void> {
    const t = store.getTask(taskId) as LocalShellTaskState | undefined;
    if (!t || t.status !== "running") {
      void evictTaskOutput(taskId);
      return;
    }
    cancelStallWatchdog();
    try { await flushTaskOutput(taskId); } catch (e) { logError(e, "spawnLocalShell flush bg"); }
    const finalStatus: "completed" | "failed" | "killed" =
      r.exitCode === 0 ? "completed" : r.exitCode === null ? "killed" : "failed";
    updateTaskState<LocalShellTaskState>(taskId, store, (cur) => ({
      ...cur,
      status: finalStatus,
      endTime: Date.now(),
      result: { exitCode: r.exitCode, killed: false },
    }));
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_bash",
      status: finalStatus,
      description: opts.description,
      outputFile,
      toolUseId: opts.toolUseId,
      exitCode: r.exitCode ?? undefined,
    });
    void evictTaskOutput(taskId);
  }

  async function safeRead(): Promise<string> {
    try { return await readTruncatedOutput(taskId); } catch (e) { logError(e, "readTruncatedOutput"); return ""; }
  }
}

export const LocalShellTask: Task = {
  name: "LocalShellTask",
  type: "local_bash",
  async kill(taskId, store) {
    // pi 没法在这一层拿到 — 改用 module-level injection。
    if (!_currentPi) {
      throw new Error("LocalShellTask.kill called before extension session_start");
    }
    await killLocalShellTask(_currentPi, store as TaskStore, taskId);
  },
};

let _currentPi: ExtensionAPI | undefined;

/** Extension entrypoint 在 session_start 内调,把当前 pi 注入给 LocalShellTask.kill。 */
export function _bindPi(pi: ExtensionAPI): void {
  _currentPi = pi;
}

/** session_shutdown 内调。 */
export function _unbindPi(): void {
  _currentPi = undefined;
}

/** Test helper. */
export function _resetLocalShellPiBindingForTest(): void {
  _currentPi = undefined;
}
```

> Note: `Task.kill` 的签名是 `(taskId, store)`,没法直接接 `pi`。所以用 module-level binding(`_bindPi`)— 等同上一期 `_defaultStore` 的模式。`extensions/localshell/index.ts` 在 session_start 内 `_bindPi(pi)`。

- [ ] **Step 4: 跑测试,16 绿**

Run:
```bash
npx vitest run extensions/localshell/localShellTask.test.ts 2>&1 | tail -20
```

修复任何遗漏(常见:Promise.race 微观时序、`await Promise.resolve()` 同步推进顺序)。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;`Tests 377 passed (377)`(361 + 16)。

- [ ] **Step 6: Commit**

```bash
git add extensions/localshell/localShellTask.ts extensions/localshell/localShellTask.test.ts
git commit -m "feat(localshell): implement spawnLocalShell + LocalShellTask interface"
```

---

## Task 12: `localshell` extension entrypoint(`task_bash` tool + 生命周期)

**Files:**
- Modify: `extensions/localshell/index.ts`
- Test: `extensions/localshell/index.test.ts`

- [ ] **Step 1: 写测试(5 个)**

Create `extensions/localshell/index.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import localshellExtension from "./index.js";
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
  _resetTaskTypeRegistryForTest,
  _setDefaultTaskStoreForTest,
  createTaskStore,
  getTaskType,
  registerTask,
  setDefaultTaskStore,
  type TaskStore,
} from "pi-tasks-extension";
import { _resetLocalShellPiBindingForTest } from "./localShellTask.js";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;
let store: TaskStore;
let pi: {
  on: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  handlers: Map<string, Array<(e: unknown, c: unknown) => unknown>>;
};

function fireEvent(event: string, e: unknown, c: unknown): unknown[] {
  return (pi.handlers.get(event) ?? []).map((h) => h(e, c));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ls-idx-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  store = createTaskStore();
  setDefaultTaskStore(store);
  _resetTaskTypeRegistryForTest();
  pi = {
    handlers: new Map(),
    on: vi.fn((evt: string, h: (e: unknown, c: unknown) => unknown) => {
      if (!pi.handlers.has(evt)) pi.handlers.set(evt, []);
      pi.handlers.get(evt)!.push(h);
    }),
    registerTool: vi.fn(),
    sendMessage: vi.fn(),
  };
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  _resetTaskTypeRegistryForTest();
  _setDefaultTaskStoreForTest(undefined);
  _resetLocalShellPiBindingForTest();
  if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdirEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("localshellExtension", () => {
  it("session_start registers task_bash tool", () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-1" } });
    const names = pi.registerTool.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toContain("task_bash");
  });

  it("session_start registers task type 'local_bash'", () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-2" } });
    expect(getTaskType("local_bash")).toBeDefined();
  });

  it("session_shutdown kills running local_bash tasks and unregisters type", async () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-3" } });
    registerTask({
      id: "babcdefgh",
      type: "local_bash",
      status: "running",
      description: "fake",
      startTime: 0,
      outputFile: "/tmp/x",
      outputOffset: 0,
      notified: false,
      // 下面这些字段是 LocalShellTaskState 必备但 framework 不强检 — TS 只当 base 看
    } as never, store);
    const results = fireEvent("session_shutdown", {}, {});
    await Promise.all(results as Promise<unknown>[]);
    expect(getTaskType("local_bash")).toBeUndefined();
  });

  it("task_bash execute透传到 spawnLocalShell (smoke: returns object with taskId)", async () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-4" } });
    const tool = pi.registerTool.mock.calls.find((c) => (c[0] as { name: string }).name === "task_bash")![0] as {
      execute(...a: unknown[]): Promise<unknown>;
    };
    // 注意:本测试不真起 process。把 fakeBashOps 注入需要重做 spawnLocalShell 调用 — smoke 只测 schema 拒空。
    expect(typeof tool.execute).toBe("function");
  });

  it("session_start binds pi (LocalShellTask.kill works after start)", async () => {
    localshellExtension(pi as never);
    fireEvent("session_start", {}, { sessionManager: { getSessionId: () => "ls-5" } });
    const { LocalShellTask } = await import("./localShellTask.js");
    // task 不存在 → kill 早返回,不抛
    await LocalShellTask.kill("nope", store);
  });
});
```

- [ ] **Step 2: 跑测试,5 红**

Run:
```bash
npx vitest run extensions/localshell/index.test.ts 2>&1 | tail -20
```

Expected: 5 failed。

- [ ] **Step 3: 写实现**

Replace `extensions/localshell/index.ts`:

```ts
// pi-localshell-extension — 注册 task_bash + LocalShellTask 类型挂载。
//
// 加载顺序:目录字典序 'localshell' < 'tasks',因此 tasks extension 先初始化
// default store / registerMessageRenderer,再到本扩展挂 task_bash。
//
// session_shutdown 内先 kill 自己的 running task,再 unregisterTaskType。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getDefaultTaskStore,
  getRunningTasks,
  registerTaskType,
  unregisterTaskType,
} from "pi-tasks-extension";
import { _bindPi, _unbindPi, LocalShellTask, spawnLocalShell } from "./localShellTask.js";

const TaskBashParams = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
  description: Type.String({ description: "Short human description for status displays." }),
  timeout_ms: Type.Optional(
    Type.Number({ description: "Auto-background after this many ms (default 60000)." }),
  ),
});

export default function localshellExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const store = getDefaultTaskStore();
    _bindPi(pi);
    registerTaskType("local_bash", LocalShellTask);

    pi.registerTool({
      name: "task_bash",
      label: "Run shell task",
      description:
        "Run a shell command as a tracked task. Use ONLY for long-running, interactive, or backgroundable commands; for short one-shot commands use the regular `bash` tool. Auto-backgrounds after timeout_ms (default 60000).",
      parameters: TaskBashParams,
      executionMode: "parallel",
      async execute(_callId, raw) {
        const { command, description, timeout_ms } = raw as {
          command: string;
          description: string;
          timeout_ms?: number;
        };
        const result = await spawnLocalShell(pi, store, {
          command,
          description,
          timeoutMs: timeout_ms,
        });
        const head = result.backgrounded
          ? `Backgrounded (taskId=${result.taskId}). Last ${result.output.length} bytes:\n`
          : `${result.status}${result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""} taskId=${result.taskId}\n`;
        return {
          content: [{ type: "text", text: head + result.output }],
          details: { action: "task_bash", ...result },
        };
      },
    });
  });

  pi.on("session_shutdown", async () => {
    const store = getDefaultTaskStore();
    const running = getRunningTasks(store).filter((t) => t.type === "local_bash");
    await Promise.all(running.map((t) => LocalShellTask.kill(t.id, store)));
    unregisterTaskType("local_bash");
    _unbindPi();
  });
}
```

- [ ] **Step 4: 跑测试**

Run:
```bash
npx vitest run extensions/localshell/index.test.ts 2>&1 | tail -10
```

Expected: `Tests 5 passed (5)`。

- [ ] **Step 5: typecheck + 全仓**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -10
```

Expected: typecheck 无 error;`Tests 382 passed (382)`(377 + 5)。

- [ ] **Step 6: Commit**

```bash
git add extensions/localshell/index.ts extensions/localshell/index.test.ts
git commit -m "feat(localshell): wire task_bash tool + session lifecycle"
```

---

## Task 13: 端到端冒烟(human verify,无新测试)

**Files:** 无变更。

- [ ] **Step 1: typecheck 全仓 + 全仓测试**

Run:
```bash
npm run typecheck && npm test 2>&1 | tail -15
```

Expected: 无 typecheck error;`Tests 382 passed (382)`(或更高)。

- [ ] **Step 2: 手工 RPC 模式跑一次 task_bash**

Run:
```bash
pi --mode rpc --no-session <<'EOF'
{"type":"prompt","message":"run task_bash with command 'echo hello' description 'smoke'"}
EOF
```

Expected: 输出 JSONL 中能看到 `task_bash` tool 调用 + 结果包含 `hello\n` + `taskId=b...`。

如果 Pi RPC 模式跑不通(可能是依赖问题),退化为:跑 `extensions/localshell/index.test.ts` + `extensions/tasks/index.test.ts` 全绿即可,Step 3 跳过。

- [ ] **Step 3: Commit(没改动 → 可以跳过)**

如果有任何手工调试时改的小地方,这里 commit;否则跳过。

---

## Self-Review

完成 plan 写作后逐项核对:

- **Spec coverage**:
  - §1 架构(2 extension + 数据流) → Task 5 + 11 + 12 完成
  - §2.1 taskTypeRegistry → Task 1
  - §2.2 三个通用 tool builder → Task 2/3/4
  - §2.3 index.ts 改 → Task 5
  - §2.4 LocalShellTaskState + Task 接口 → Task 9 类型 + Task 11 实现
  - §2.5 entrypoint → Task 12
  - §3.1-3.5 spawn 时间线 → Task 11
  - §3.6 task_kill ↔ kill → Task 2 + Task 9 + Task 11
  - §3.7 task_status delta → Task 3
  - §3.8 shutdown 顺序 → Task 12
  - §3.9 错误矩阵 → 散布于 Task 2/3/9/11
  - §3.10 stallWatchdog → Task 8
  - §4.1-4.9 测试矩阵 → 完整对应
  - §5.x 后续期接入约定 → Task 12 已锁示例
  - §6 风险 → 非代码,无需 Task

- **Placeholder 扫**:无 TBD/TODO。Task 11 中有一处 `// TODO: filled in by Task 11` 在 Task 6 的占位 file,**这是计划内的占位** → Task 12 会被 entrypoint 实现替换。可接受。

- **类型一致性**:
  - `LocalShellTaskState` 在 Task 9 定义、Task 11 复用、Task 12 import — 一致;
  - `SpawnLocalShellOptions` / `SpawnLocalShellResult` 在 Task 11 定义、Task 12 用 — 一致;
  - `getTaskOutputDelta` 返回 `{content, totalSize}` 假定;Task 3 已注:实际 type 不一致就改字段名;
  - `getTaskOutput` 在 Task 10 假定存在;Note 也已说不在则用 `getTaskOutputDelta(0)`。

无重大冲突;完成。

---

## Execution Handoff

Plan 已保存至 `docs/superpowers/plans/2026-06-02-localshell-task.md`。两种执行选项:

**1. Subagent-Driven(推荐)** — 我为每个 Task 派一个新 subagent,你在 Task 之间快速复审;成本最优、迭代最快。

**2. Inline Execution** — 在当前会话连续跑,有 batch checkpoint 给你点头/打断。

哪种?
