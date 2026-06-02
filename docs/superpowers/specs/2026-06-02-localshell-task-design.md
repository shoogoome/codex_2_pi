# LocalShellTask (`local_bash`) — 子项目 B 设计

**关联**: 子项目 A 已完成(`docs/superpowers/specs/2026-06-02-task-framework-design.md`)。本期是七种 TaskType 中的第一个具体实现 — `local_bash`。

## 背景与目标

子项目 A 落成了 Task 框架内核(`extensions/tasks/`),提供了:`generateTaskId` / `TaskStore` / `DiskTaskOutput` / `framework polling` / `notifyTaskTerminal`。本期在框架之上,实现 LLM 可调的"长任务 / 后台 / 可 kill 的 bash"。

最终交付:
- LLM 工具 `task_bash` — 跑长命令、超时自动转后台、有 stall watchdog。
- 通用工具 `task_kill` / `task_status` / `task_list` — 跨 task type 共享。
- LocalShellTask 的 `Task` 接口实现(注册到新增 `taskTypeRegistry`)。
- 全套 TDD 测试(目标 ~69 个新增测试,全仓 ≥382)。

不实现:LocalAgent / Teammate / Dream(后续期);Ctrl+B 一键后台;Pi UI panel;session reload 重建;monitor 子类型。

## 1. 架构总览

两个 extension 协作:

### 1.1 `extensions/tasks/`(已存在,小改)
- 新增 `taskTypeRegistry.ts` — 进程内 `Map<TaskType, Task>`,提供 `registerTaskType / getTaskType / unregisterTaskType / _resetTaskTypeRegistryForTest`。
- 新增 `tools/taskKill.ts` / `tools/taskStatus.ts` / `tools/taskList.ts` — tool builder。
- `index.ts` 在 `session_start` 内 `registerTool` 三次;在 `session_shutdown` 内 `_resetTaskTypeRegistryForTest`。
- re-export 上述新公共 API。

**不改**任何上一期已实现的逻辑(避免回归 313 测试)。

### 1.2 `extensions/localshell/`(新建)
```
extensions/localshell/
├── package.json
├── index.ts                  # entrypoint: registerTaskType + registerTool(task_bash)
├── localShellTask.ts         # Task 接口 + spawnLocalShell + 状态机
├── stallWatchdog.ts          # setInterval + tail + prompt 正则
├── kill.ts                   # killTask helper(LocalShellTask.kill 调用)
├── outputBuffer.ts           # truncate 30000 bytes 帮工
├── _test/fakeBashOperations.ts
└── *.test.ts
```

### 1.3 数据流

```
LLM → task_bash(command) → spawnLocalShell()
        ├── createLocalBashOperations().exec(command, cwd, {onData, signal, timeout})
        ├── onData(buf) → appendTaskOutput(taskId, str)
        ├── startStallWatchdog(taskId)  — 5s tick / 45s 阈值
        └── 60s timeout 命中 → setBackgrounded + 返 partial
                              → exec 继续,result handler 再发终态 notify
            60s 内完成      → 返 stdout truncate + exit code,内联 notify

LLM → task_kill(taskId) → registry.get(type).kill(taskId, store)
                       → LocalShellTask.kill → AbortController.abort + flush + state→killed + notify

watchdog 命中 prompt 正则 → pi.sendMessage<{kind:'stall-prompt'}>(customType:'tasks/notification', 无 <status>)
```

## 2. 组件接口

### 2.1 `extensions/tasks/taskTypeRegistry.ts`

```ts
import type { Task, TaskType } from "./Task.js";

export function registerTaskType(type: TaskType, task: Task): void;
export function getTaskType(type: TaskType): Task | undefined;
export function unregisterTaskType(type: TaskType): void;
export function _resetTaskTypeRegistryForTest(): void;
```

- 同 type 重复注册:覆盖 + `console.warn` 一次。
- registry 是模块级单例(等同 `_defaultStore` / `_taskOutputDir`)。

### 2.2 通用 tool builders

```ts
// extensions/tasks/tools/taskKill.ts
export function buildTaskKillTool(): ToolDefinition<...>;
// extensions/tasks/tools/taskStatus.ts
export function buildTaskStatusTool(): ToolDefinition<...>;
// extensions/tasks/tools/taskList.ts
export function buildTaskListTool(): ToolDefinition<...>;
```

| tool | 输入 | 输出 |
|---|---|---|
| `task_kill` | `{task_id}` | `"killed"` / `"not found"` / `"already <status>"` / `"task type ... not registered"` |
| `task_status` | `{task_id, output_offset?}` | `{status, type, description, exitCode?, output_delta, total_lines}` |
| `task_list` | `{filter?: "running" \| "all"}` | `[{id, type, status, description, startTime, endTime?}]`(默认 filter='running') |

`task_status` 用上一期已暴露的 `getTaskOutputDelta(taskId, offset)` 推进 LLM 端 offset。

### 2.3 LocalShell Task 状态

```ts
export interface LocalShellTaskState extends TaskStateBase {
  type: "local_bash";
  command: string;
  cwd: string;
  abortController: AbortController;
  cancelStallWatchdog?: () => void;
  isBackgrounded: boolean;          // 被 timeout 自动转后台后翻 true
  result?: { exitCode: number | null; killed: boolean };
}

export const LocalShellTask: Task = {
  name: "LocalShellTask",
  type: "local_bash",
  async kill(taskId, store) { /* 见 §3.5 */ },
};
```

### 2.4 spawn 入口

```ts
export interface SpawnLocalShellOptions {
  command: string;
  description: string;
  toolUseId?: string;
  timeoutMs?: number;             // 默认 60_000
  cwd?: string;                   // 默认 process.cwd()
  operations?: BashOperations;    // 测试注入;生产用 createLocalBashOperations()
}

export interface SpawnLocalShellResult {
  taskId: string;
  status: "completed" | "failed" | "killed" | "running";
  backgrounded: boolean;
  exitCode?: number;
  output: string;                 // truncate 到 MAX_OUTPUT_BYTES (30000)
  outputFile: string;
  backgroundReason?: "timeout" | "user_request";
}

export async function spawnLocalShell(
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalShellOptions,
): Promise<SpawnLocalShellResult>;
```

### 2.5 entrypoint

```ts
export default function localshellExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const store = getDefaultTaskStore();
    registerTaskType("local_bash", LocalShellTask);
    pi.registerTool({
      name: "task_bash",
      description: "Run a shell command as a tracked task. Long-running commands automatically background after 60s.",
      params: Type.Object({
        command: Type.String(),
        description: Type.String(),
        timeout_ms: Type.Optional(Type.Number()),
      }),
      execute: async ({ command, description, timeout_ms }) =>
        spawnLocalShell(pi, store, { command, description, timeoutMs: timeout_ms }),
    });
  });

  pi.on("session_shutdown", async () => {
    const store = getDefaultTaskStore();
    const running = getRunningTasks(store).filter(t => t.type === "local_bash");
    await Promise.all(running.map(t => LocalShellTask.kill(t.id, store)));
    unregisterTaskType("local_bash");
  });
}
```

## 3. 数据流与边界

### 3.1 spawn 时间线

```
let resultRef: ExecResult | null = null
let resolved = false
const execPromise = ops.exec(...).then(r => {
  resultRef = r
  onExecResult(r)            // fire-and-forget,始终触发
})

return new Promise(resolve => {
  const timer = setTimeout(() => {
    if (resolved) return
    resolved = true
    onTimeout(resolve)        // 转后台 + 返 partial
  }, timeoutMs)

  execPromise.then(() => {
    clearTimeout(timer)
    if (resolved) return
    resolved = true
    onSyncFinish(resolve, resultRef!)
  })
})
```

两个独立闭环:`resolve` 决定 tool result 何时返回 LLM;`onExecResult` 决定终态 + notify。`BashOperations.exec` 的 timeout 不控 process 寿命 — 它只看 `signal`。所以 timeout 转后台时**不 abort**,让 exec 继续跑。

### 3.2 result handler

```
onExecResult({exitCode}):
  switch task.status:
    'killed': evictTaskOutput(taskId)            // kill 路径已 notify 过
    'running':
      cancelStallWatchdog()
      await flushTaskOutput(taskId)              // 必须在 status 翻 terminal 前
      finalStatus = exitCode === 0 ? 'completed'
                  : exitCode === null ? 'killed'
                  : 'failed'
      updateTaskState(...)                       // status / endTime / result
      if (task.isBackgrounded):
        notifyTaskTerminal(...)                  // CAS 兜底;LLM 已收过 partial,这条补终态
      // sync 路径会自己 notify,这里不重发
      evictTaskOutput(taskId)
```

`notifyTaskTerminal` 的 CAS 是最后保险 — 即便 sync 路径与 result handler 冲突,也只发一条。

### 3.3 sync finish 路径

```
onSyncFinish(resolve, result):
  cancelStallWatchdog()
  await flushTaskOutput(taskId)
  finalStatus = result.exitCode === 0 ? 'completed' : 'failed'
  updateTaskState(taskId, store, t => ({...t, status: finalStatus, endTime: Date.now(), result}))
  notifyTaskTerminal(...)                        // 翻 notified=true
  const output = await readTruncatedOutput(taskId, MAX_BYTES)
  resolve({taskId, status: finalStatus, backgrounded: false, exitCode, output, outputFile})
  evictTaskOutput(taskId)
```

### 3.4 timeout → 转后台

```
onTimeout(resolve):
  updateTaskState(taskId, store, t => ({...t, isBackgrounded: true}))
  // watchdog 不停;exec 不 abort;result handler 异步还会 fire
  const partial = await readTruncatedOutput(taskId, MAX_BYTES)
  resolve({taskId, status: 'running', backgrounded: true, output: partial, outputFile,
           backgroundReason: 'timeout'})
```

LLM 在下一个 turn 才看见终态 notify(deliverAs:'nextTurn' 默认)。

### 3.5 LocalShellTask.kill

```
async kill(taskId, store):
  const task = store.getTask(taskId)
  if (!task || task.status !== 'running') return     // 已 terminal,no-op

  task.cancelStallWatchdog?.()
  try { task.abortController.abort() } catch (e) { logError(e) }
  await flushTaskOutput(taskId)
  updateTaskState(taskId, store, t => t.status === 'running'
    ? {...t, status: 'killed', endTime: Date.now()} : t)
  notifyTaskTerminal(...)                            // CAS 翻 notified
  // exec.then 仍会 fire,走 case 'killed' 早返回
  evictTaskOutput(taskId)
```

CAS 不变量:`status:'killed'` 早于 `notifyTaskTerminal`。

### 3.6 task_kill tool ↔ kill 函数

```
task_kill({task_id}):
  task = store.getTask(task_id)
  if (!task)            return "not found"
  if (terminal(task))   return `already ${task.status}`
  Task = getTaskType(task.type)
  if (!Task)            return `task type ${task.type} not registered`
  await Task.kill(task_id, store)
  return "killed"
```

### 3.7 task_status

直读 `store.getTask(taskId)` + `getTaskOutputDelta(taskId, offset)`,返回当前 status / type / description / exitCode? + delta。

### 3.8 session_shutdown 顺序

LocalShell 的 shutdown handler 内 `await` 全部 kill 完成。即使 Pi 并行触发 shutdown,tasks 的 `_clearOutputsForTest` 看到 `outputs` Map 为空就 no-op,实际安全。

### 3.9 错误矩阵

| 场景 | 行为 |
|---|---|
| `operations.exec` 抛(spawn 失败) | resolve 时 status='failed' / output 含 error / notify failed / evict |
| `appendTaskOutput` 抛 | logError + 继续 |
| `flushTaskOutput` 抛 | logError + 继续 |
| `notifyTaskTerminal` 抛 | logError + 继续 |
| watchdog `stat` 抛(file 还没创建) | swallow |
| watchdog `tail` 抛 | swallow + 不发 prompt 通知 |
| `kill` 在 task 已 terminal 调 | 早返回 + evict 是 idempotent |

### 3.10 stall watchdog

```ts
const STALL_CHECK_INTERVAL_MS = 5_000;
const STALL_THRESHOLD_MS = 45_000;
const STALL_TAIL_BYTES = 1024;

const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)/i, /\[y\/n\]/i, /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i, /Continue\?/i, /Overwrite\?/i,
];
```

- 5s `stat(outputFile)`;不增 ≥ 45s → tail 1024 bytes;
- `looksLikePrompt(tail)` true → latch + clearInterval + 发**进度通知**(复用 `tasks/notification` customType,`details.extra.kind = 'stall-prompt'`,XML 不带 `<status>` tag);
- 不 prompt → 重置 `lastGrowth = Date.now()`,不连发;
- task 完成或 kill → 调用方 `cancelStallWatchdog()`。

> 注:为不破坏上一期 `TaskNotificationDetails` 类型,stall-prompt 标记走已有的 `extra: Record<string, unknown>` 字段(`extra.kind = 'stall-prompt'`),不修类型。Renderer 在 `details.extra?.kind === 'stall-prompt'` 时切到黄色 + ⏳ 图标分支。同时,XML content 由本期新加的 `buildStallPromptXml(...)` 构造(不复用 `buildTaskNotificationXml`,因为后者强制有 `<status>`)。

## 4. 测试覆盖矩阵

约 **69 个新增测试**,全仓 ≥382。

### 4.1 `extensions/tasks/taskTypeRegistry.test.ts`(8)
register / 同 type 覆盖 + warn / get unknown / unregister / 重复 unregister / reset / 隔离 / 模块级单例。

### 4.2 `extensions/tasks/tools/taskKill.test.ts`(8)
not found / already terminal / type 未注册 / running 调 task.kill / kill 抛不 crash / kill 后状态 / 入参 schema 拒空 / ToolDefinition 形状。

### 4.3 `extensions/tasks/tools/taskStatus.test.ts`(6)
not found / offset=0 全量 / offset=N 增量 / terminal 含 endTime+exitCode / offset 超 size 空字符串 / schema。

### 4.4 `extensions/tasks/tools/taskList.test.ts`(5)
空 store / running 过滤 / all 过滤 / 默认 running / 字段完整。

### 4.5 `extensions/tasks/index.test.ts`(+3)
registerTool ×3 都被调 / tool name 含三者 / shutdown 调 reset。

### 4.6 `extensions/localshell/stallWatchdog.test.ts`(12)
PROMPT_PATTERNS 各命中(参数化)/ 不命中纯输出 / size 增长不发 / size 不增 < 45s 不发 / size 不增 ≥ 45s + 非 prompt 不发 + 重置 / size 不增 ≥ 45s + prompt → sendMessage 一次(`details.extra.kind === 'stall-prompt'`)/ latch 不重发 / cancel 后不再触发 / stat 抛跳过 / tail 抛跳过 / 内容不带 `<status>` / `timer.unref()` 调用。

### 4.7 `extensions/localshell/kill.test.ts`(6)
不存在 no-op / terminal no-op / running → status='killed' + abort + endTime / cancelStallWatchdog 调 / notifyTaskTerminal 调一次 / 重复 kill no-op。

### 4.8 `extensions/localshell/localShellTask.test.ts`(16,主力)
spawn 注册 store + status:'running' / initTaskOutput / cancelStallWatchdog 入 state / 60s 内 exitCode=0 sync / exitCode=1 → failed / exitCode=null → killed / 一次 notify / output truncate 30000 / timeout=100ms 慢 exec → backgrounded:true / 转后台后 exec 完成 → notify 终态 / 转后台后被 kill → killed 不重复 notify / onData 多次写入 / exec 抛 spawn fail / flush await / cancelStallWatchdog / evictTaskOutput。

### 4.9 `extensions/localshell/index.test.ts`(5)
registerTool 注册 task_bash / registerTaskType 调用 / shutdown kill 全部 / shutdown unregisterTaskType / execute 透传 spawnLocalShell。

### 4.10 共用 helpers

`extensions/localshell/_test/fakeBashOperations.ts`:`createFakeBashOps()` 返回 `{ops, emit(buf), finish(exitCode), aborted}`,12 测试基于它写,不真起进程。

## 5. 后续期接入约定

```ts
// 后续 task type extension entrypoint 模板
export default function myExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const store = getDefaultTaskStore();
    registerTaskType(MyTask.type, MyTask);
    pi.registerTool({ /* spawn tool */ });
  });
  pi.on("session_shutdown", async () => {
    const store = getDefaultTaskStore();
    const running = getRunningTasks(store).filter(t => t.type === MyTask.type);
    await Promise.all(running.map(t => MyTask.kill(t.id, store)));
    unregisterTaskType(MyTask.type);
  });
}
```

四步固化:lazy 取 store / `registerTaskType + registerTool` 配对 / shutdown 先 kill 同 type running / Task.kill 实现负责 abort+flush+notify+evict。

后续期(LocalAgent / Teammate / Dream)**不再注册自己的 kill/status/list 工具**。

### customType 命名空间分配
| customType | 用途 | 状态 |
|---|---|---|
| `tasks/notification` | 终态 + stall-prompt 进度 | 本期复用,通过 `details.extra.kind` 区分(不改 TaskNotificationDetails 类型) |
| `tasks/progress` | 长任务中途进度 | 留 schema(后续期) |
| `tasks/snapshot` | reload 重建 | 留 schema |
| `tasks/output-pointer` | 大输出告知 RPC client | 留 schema |

### 与 RPC / JSON / TUI / session-format 的兼容
完全沿用 `pi.sendMessage` 单一入口 — 无模式特定代码。`stall-prompt` 通知 renderer 在 `details.extra?.kind === 'stall-prompt'` 时用不同图标(⏳)+ 黄色;此为 `extensions/tasks/notifications.ts` 渲染器的小改(只加分支,不改既有路径)。

### 与 Pi 内置 bash tool 的关系
两者并存;`task_bash` 描述里写 "only use for long-running or interactive commands"。用户/LLM 可在 `setActiveTools` 里自选。

## 6. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `createLocalBashOperations` 是 Pi 内部 API,版本变动可能改签名 | LocalShell 编译失败 | peerDependency 钉版本范围 + plan 期跑 typecheck;变动需要补 adapter |
| `BashOperations.exec` 没有 timeout 控 process 寿命 | timeout 自动转后台后 abort 走 AbortController | 已设计 |
| `session_shutdown` handler 触发顺序未明 | LocalShell kill 可能被 tasks 的 `_clearOutputsForTest` 先清盘 | LocalShell shutdown await 全部 kill;`outputs` Map 空时 no-op |
| `setInterval` + `timer.unref()` 在 Vitest 假时钟下行为差异 | 测试不稳定 | 用 `vi.useFakeTimers()` + `vi.advanceTimersByTime`,不依赖 unref |
| 大量二进制 stdout 直接转 utf8 截断到 30k | LLM 看到乱码 | 与 Claude 行为一致(用户问题,不是设计问题) |
| LLM 误用 `task_bash` 跑短命令 | 浪费 token | tool description 提示 + Pi 内置 `bash` 留作主路 |

## 7. Out of Scope

- LocalAgent / Teammate / Dream 任何具体实现(子项目 C / D / E)
- 用户级 Ctrl+B 一键所有后台化(需 keybinding hook + UI)
- Pi UI 内的 task panel / status pill widget
- session reload 重建 task store (`hydrateFromSessionEntries`)
- monitor 类 task(Claude `BashTaskKind = 'bash' | 'monitor'` 中 monitor 分支)
- BackgroundHint UI(Pi 没有交互式 prompt 阻塞 LLM 的能力)
- 复刻 Claude `feature('MONITOR_TOOL')` 特性开关
- Multi-shell support / custom env / LLM-传入 cwd(走默认)

## 8. 估算

约 ~7 小时实现 + 测试。生产代码 ~900 行,测试 ~1100 行。一次迭代完成,中间在 §4.6/4.8 完成后跑全测一次。
