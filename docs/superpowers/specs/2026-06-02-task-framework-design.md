# Task Framework Core (extensions/tasks) — Design

## 背景

Claude Code 在 `claude/Task.ts` + `claude/utils/task/framework.ts` + `claude/utils/task/diskOutput.ts` 提供了一整套统一的"后台任务"基建,被七种 TaskType(`local_bash` / `local_agent` / `remote_agent` / `in_process_teammate` / `local_workflow` / `monitor_mcp` / `dream`)共享。其要点是:

- `Task` 接口只暴露 `kill`,生命周期由各类型自己 spawn,统一通过 `AppState.tasks: Record<id, TaskState>` 串起来。
- `DiskTaskOutput` 是跨类型共享的输出契约:O_NOFOLLOW + O_EXCL 防 sandbox symlink 攻击,5GB 截断,offset 增量读,GC 友好的写盘队列。
- `notified` 是原子 CAS,防止终态通知重复。
- `evictTerminalTask` 在 `notified=true` 且非 retain 时收回内存。

本仓库的 `pi-codex-replica` 已有 `extensions/subagents`、`extensions/side` 等扩展各自管自己的状态,**但没有统一的 Task 抽象**。后续要复刻 `local_bash` / `local_agent` / `in_process_teammate` / `dream` 四种 task 类型时(其余三种 — `remote_agent` / `monitor_mcp` / `local_workflow` — 因依赖 Anthropic 服务端或 Claude 私有 feature,本仓库不实现实体,只保留 type 占位),都需要这个共享地基。

本期目标:**只做框架内核**(子项目 A)。LocalShell / LocalAgent / Teammate / Dream 接入留给后续期。

## 范围

### 实现

- `extensions/tasks/` 作为独立 sub-extension(与 `extensions/subagents`、`extensions/diff` 同级)。
- `Task` 接口 + `TaskType` / `TaskStatus` / `TaskStateBase`。
- `TaskStore`:替代 Claude `AppState.tasks` 的 extension 内存状态托管(get/set/subscribe + sessionId latch)。
- `framework`:`registerTask` / `updateTaskState` / `evictTerminalTask` / `getRunningTasks` / `pollTasks` / `isTerminalTaskStatus`。
- `diskOutput`:**完整一比一移植** Claude `DiskTaskOutput`(队列驱动 + O_NOFOLLOW + O_EXCL + 5GB 截断 + offset delta + symlink 模式 + `_clearOutputsForTest`)。
- `outputPath`:`getTaskOutputDir/getTaskOutputPath` 与 sessionId latch。
- `notifications`:`notifyTaskTerminal` / `markTaskNotified`,统一封装"task-notification 终态告知"通路。
- `index.ts`:extension entrypoint,接 `session_start` / `session_shutdown`,注册 `task-notification` renderer,启停 framework polling。
- 完整单元测试 + 集成测试。

### 不实现(本期)

- 任何具体 task type 的 spawn 逻辑(LocalShell、LocalAgent、Teammate、Dream)。
- Session reload 时从 JSONL 还原 task store(留 `hydrateFromSessionEntries` hook,不调用 Pi API 写入)。
- 模型 facing 的 progress / 中途通知(只 schema 占位)。
- 跨 task type 的 panel UI / status pill widget。
- subagents 扩展的接入改造。

## 与 Pi 的集成约束

- **不改 Pi core**。所有能力来自 `@earendil-works/pi-coding-agent` 公开 API。
- **不依赖 React**。Claude 的 `setAppState` 是 React state setter,本框架用 `TaskStore` 接口(纯数据 + listener),职责对等。
- 与现有 sub-extension 一致:`package.json` 复用 `subagents/package.json` 风格(`type:"module"` / `main:"index.ts"` / `pi.extensions:["index.ts"]` / peerDeps 指 `@earendil-works/pi-coding-agent` 等)。
- 根 `package.json` 的 `pi.extensions: ["./extensions"]` 已自动包含 `extensions/tasks/`,无需更改。
- 编码风格遵循 AGENTS.md:严格 ESM、相对 import 加 `.js`、两空格缩进、双引号、分号、尾随逗号。

## 目录结构

```
extensions/tasks/
├─ package.json
├─ index.ts             # extension entrypoint
├─ Task.ts              # 公共类型 + generateTaskId / createTaskStateBase / isTerminalTaskStatus
├─ taskStore.ts         # createTaskStore + setDefaultTaskStore / getDefaultTaskStore
├─ framework.ts         # registerTask / updateTaskState / evictTerminalTask / pollTasks / 常量
├─ diskOutput.ts        # DiskTaskOutput 类 + 模块级 outputs Map + 公共 API
├─ outputPath.ts        # getTaskOutputDir / getTaskOutputPath / _resetTaskOutputDirForTest
├─ notifications.ts     # notifyTaskTerminal / markTaskNotified + renderer 注册
├─ xmlTags.ts           # task-notification 标签常量(对齐 Claude)
├─ Task.test.ts
├─ taskStore.test.ts
├─ framework.test.ts
├─ diskOutput.test.ts
├─ outputPath.test.ts
├─ notifications.test.ts
└─ index.test.ts
```

## 公共类型 — `Task.ts`

```ts
export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'in_process_teammate'
  | 'dream'
  | 'remote_agent'        // 占位:依赖 Anthropic 服务端,本仓库不实现
  | 'local_workflow'      // 占位:Claude 私有 feature
  | 'monitor_mcp'         // 占位:依赖 MCP streaming

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed'

export interface TaskStateBase {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}

export interface Task {
  name: string
  type: TaskType
  kill(taskId: string, store: TaskStore): Promise<void>
}

export function isTerminalTaskStatus(status: TaskStatus): boolean
export function generateTaskId(type: TaskType): string
export function createTaskStateBase(
  id: string, type: TaskType, description: string, toolUseId?: string
): TaskStateBase
```

`generateTaskId` 复刻 Claude 实现:每个 type 一个单字符 prefix(`b/a/r/t/w/m/d`,默认 `x`),后跟 8 位 36 进制随机串。两个表都列出来:

| TaskType | prefix |
|---|---|
| local_bash | `b` |
| local_agent | `a` |
| remote_agent | `r` |
| in_process_teammate | `t` |
| local_workflow | `w` |
| monitor_mcp | `m` |
| dream | `d` |

`createTaskStateBase` 等价 Claude 同名函数:status 默认 `pending`,startTime=Date.now(),outputFile=getTaskOutputPath(id),outputOffset=0,notified=false。

## TaskStore — `taskStore.ts`

替代 Claude `AppState.tasks + setAppState`。

```ts
type Snapshot = Record<string, TaskStateBase>

export interface TaskStore {
  get(): Snapshot
  getTask(id: string): TaskStateBase | undefined
  set(updater: (prev: Snapshot) => Snapshot): void
  subscribe(listener: (snapshot: Snapshot) => void): () => void
  getSessionId(): string                  // 默认 'default-session'
  _setSessionId(id: string): void          // session_start hook 调
  _resetForTest(): void
}

export function createTaskStore(): TaskStore

let _defaultStore: TaskStore | undefined
export function setDefaultTaskStore(s: TaskStore): void
export function getDefaultTaskStore(): TaskStore       // 未初始化时 throw
export function _setDefaultTaskStoreForTest(s?: TaskStore): void
```

不变量:

1. `set(updater)`:若 `updater(prev) === prev`,**不通知 listeners**(性能 + 防误触发)。否则 listeners 同步收到新 snapshot。
2. `subscribe(listener)` 立刻返回 unsubscribe 函数,**不立刻调用 listener**(等价 Claude — 调用方自行读初始 snapshot)。
3. `getTask(id)` 返回 snapshot 内引用(只读约定,使用方不应直接 mutate)。
4. `_setSessionId` 同步更新内部 sessionId,被 `outputPath.ts` 通过 `getDefaultTaskStore().getSessionId()` 拉取。

## Output 路径 — `outputPath.ts`

```ts
let _taskOutputDir: string | undefined

export function getTaskOutputDir(): string
  // 首次调用 latch:join(tmpdir(), 'pi-tasks', getDefaultTaskStore().getSessionId(), 'tasks')
  // 等价 Claude 的 first-call latch — 防止 sessionId 切换导致路径漂移。

export function getTaskOutputPath(taskId: string): string
  // join(getTaskOutputDir(), `${taskId}.output`)

export function _resetTaskOutputDirForTest(): void
```

`session_start` hook 调一次 `_resetTaskOutputDirForTest()`,再读新 sessionId 重新 latch。

## Disk Output — `diskOutput.ts`

**完整一比一移植** Claude `DiskTaskOutput` 类的全部要害:

1. `#queue: string[]` + `#queueToBuffers()` 单方法隔离 → GC 友好。
2. `#writeAllChunks()` **不 await**(刻意:加 await 会让 buffer 队列堆积)。
3. **Unix**: `O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW`(防 sandbox 写穿到 host 任意文件)。**Windows**: `'a'`(numeric flag 不通过 libuv)。
4. `initTaskOutput` 用 `O_EXCL`(同 id 二次 init 失败)。
5. `MAX_TASK_OUTPUT_BYTES = 5GB`,超过后 push `[output truncated: exceeded 5GB disk cap]` 后 `#capped=true`,后续 append 静默丢弃。
6. `_pendingOps: Set<Promise>` + 内部 `track()` + `_clearOutputsForTest()`:测试 teardown 安全(避免 async-ENOENT-after-teardown)。
7. `drain` 异常:catch 并 logError,如果 queue 还有内容**重试一次**;再失败 logError 不抛。
8. `evictTaskOutput`(flush + 从 outputs Map 移除,**不 unlink**) vs `cleanupTaskOutput`(cancel + delete + unlink)。

API 表面:

```ts
export class DiskTaskOutput { /* ... */ }

export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

export function appendTaskOutput(taskId: string, content: string): void
export function flushTaskOutput(taskId: string): Promise<void>
export function evictTaskOutput(taskId: string): Promise<void>
export function cleanupTaskOutput(taskId: string): Promise<void>
export function getTaskOutputDelta(taskId: string, fromOffset: number, maxBytes?: number): Promise<{ content: string; newOffset: number }>
export function getTaskOutput(taskId: string, maxBytes?: number): Promise<string>
export function getTaskOutputSize(taskId: string): Promise<number>
export function initTaskOutput(taskId: string): Promise<string>
export function initTaskOutputAsSymlink(taskId: string, targetPath: string): Promise<string>
export async function _clearOutputsForTest(): Promise<void>
```

`fsOperations` 内联实现(Claude 在 utils/fsOperations.ts 提供,本仓库自带 40 行):

```ts
async function readFileRange(
  path: string, offset: number, maxBytes: number
): Promise<{ content: string; bytesRead: number } | null>
  // fs.open → fs.read(buffer, 0, maxBytes, offset) → fs.close
  // 返回 null 表示 ENOENT;返回 0 字节表示 offset >= size

async function tailFile(
  path: string, maxBytes: number
): Promise<{ content: string; bytesTotal: number; bytesRead: number }>
  // stat → readFileRange(max(0, size - maxBytes), maxBytes)
```

## Framework — `framework.ts`

```ts
export const POLL_INTERVAL_MS = 1000
export const STOPPED_DISPLAY_MS = 3_000
export const PANEL_GRACE_MS = 30_000   // 占位,本期不直接使用,LocalAgent 期会用

export function updateTaskState<T extends TaskStateBase>(
  taskId: string, store: TaskStore, updater: (task: T) => T,
): void
  // 在 store.set 内部读 fresh task,调 updater,如返回引用相同则 set 早返回不通知。

export function registerTask(task: TaskStateBase, store: TaskStore): void
  // 直接覆盖式注册。本期不做 retain merge — 那是 LocalAgent 自己 wrapper 的关注。

export function evictTerminalTask(taskId: string, store: TaskStore): void
  // 仅 terminal && notified 时执行。
  // 兼容 future LocalAgent:duck-typing 'retain' in task 且 evictAfter > Date.now() 时不动。

export function getRunningTasks(snapshot: Snapshot): TaskStateBase[]

let _pollTimer: NodeJS.Timeout | undefined
export function startTaskFrameworkPolling(store: TaskStore, intervalMs?: number): void
export function stopTaskFrameworkPolling(): void

export async function pollTasks(store: TaskStore): Promise<{
  evictedTaskIds: string[]
  updatedTaskOffsets: Record<string, number>
}>
  // 本期只做两件事:
  // (a) 扫 terminal+notified → evictTerminalTask
  // (b) 扫 running → getTaskOutputDelta 推进 outputOffset
  // **不发任何模型可见消息** — 终态通知由 notifyTaskTerminal 主动发起,不由 poll 反推。
```

## 通知 — `notifications.ts`

替代 Claude 的 `enqueueShellNotification` / `enqueueAgentNotification` 的"终态告知 LLM" 部分。本期 task type 都没有,仅提供 API。

```ts
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export interface TaskNotificationDetails {
  taskId: string
  taskType: TaskType
  status: 'completed' | 'failed' | 'killed'
  description: string
  outputFile: string
  toolUseId?: string
  exitCode?: number
  finalMessage?: string
  worktreePath?: string
  worktreeBranch?: string
  durationMs?: number
  timestamp: number
  extra?: Record<string, unknown>
}

export interface NotifyTaskTerminalOptions extends Omit<TaskNotificationDetails, 'timestamp'> {
  triggerTurn?: boolean   // 默认 false:只 send custom message,不抢主 agent turn
  summary?: string        // 自定义文案(覆盖默认按 status 模板)
}

export function markTaskNotified(taskId: string, store: TaskStore): boolean
  // CAS:在 store.set 内部 if (task.notified) 早返回;否则置 true。
  // 返回 true iff 这次调用从 false 翻到 true。

export function notifyTaskTerminal(
  pi: ExtensionAPI, store: TaskStore, opts: NotifyTaskTerminalOptions,
): void
  // 1. markTaskNotified — 第二次调用静默跳过
  // 2. 拼 XML content + Details
  // 3. pi.sendMessage({ customType: TASK_NOTIFICATION_CUSTOM_TYPE, content, display, details },
  //                   { triggerTurn: opts.triggerTurn ?? false, deliverAs: 'nextTurn' })

export const TASK_NOTIFICATION_CUSTOM_TYPE = 'tasks/notification'

export function registerTaskNotificationRenderer(pi: ExtensionAPI): void
  // pi.registerMessageRenderer<TaskNotificationDetails>(TASK_NOTIFICATION_CUSTOM_TYPE, ...)
  // 折叠:`✓ "{description}" {statusText}{exitCode?}` 一行,带状态色
  // 展开:三行 + 完整 XML(给 power user)
```

XML schema(对齐 Claude `claude/constants/xml.ts` 中相关 tag):

```xml
<task_notification>
<task_id>{taskId}</task_id>
<tool_use_id>{toolUseId}</tool_use_id>             <!-- 可选 -->
<task_type>{taskType}</task_type>
<output_file>{outputFile}</output_file>
<status>{status}</status>
<summary>{description} {statusText}</summary>
<exit_code>{exitCode}</exit_code>                  <!-- 可选,仅 local_bash -->
<result>{finalMessage}</result>                    <!-- 可选 -->
<worktree>
  <path>{worktreePath}</path>
  <branch>{worktreeBranch}</branch>
</worktree>                                        <!-- 可选 -->
</task_notification>
```

`statusText` 模板:`completed` → `completed successfully`;`failed` → `failed`;`killed` → `was stopped`。

## 命名空间约定(本期定死)

| customType | 通道 | 目的 | 本期产生? |
|---|---|---|---|
| `tasks/notification` | custom_message | 终态通知:LLM + 用户 + RPC + JSON | ✓(由 notifyTaskTerminal) |
| `tasks/progress` | custom_message | 中途 progress | ✗(留 schema) |
| `tasks/snapshot` | custom(静默) | 状态快照写入 session JSONL | ✗(留 hook) |
| `tasks/output-pointer` | custom(静默) | 绑定 outputFile 路径,reload 用 | ✗(LocalShell 期接) |

`tasks/` 前缀作为命名空间标识,客户端 / 后续 hydrate 逻辑用前缀过滤。

## Extension Entrypoint — `index.ts`

```ts
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  createTaskStore, setDefaultTaskStore, _setDefaultTaskStoreForTest,
} from './taskStore.js'
import { _resetTaskOutputDirForTest } from './outputPath.js'
import {
  startTaskFrameworkPolling, stopTaskFrameworkPolling,
} from './framework.js'
import { _clearOutputsForTest } from './diskOutput.js'
import { registerTaskNotificationRenderer } from './notifications.js'

export interface TasksExtensionDeps {
  storeFactory?: () => TaskStore
  pollIntervalMs?: number
}

export default function tasksExtension(pi: ExtensionAPI, deps: TasksExtensionDeps = {}) {
  const store = deps.storeFactory?.() ?? createTaskStore()
  setDefaultTaskStore(store)

  registerTaskNotificationRenderer(pi)

  pi.on('session_start', async (_event, ctx) => {
    store._setSessionId(ctx.sessionManager.getSessionId())
    _resetTaskOutputDirForTest()
    startTaskFrameworkPolling(store, deps.pollIntervalMs ?? 1000)
  })

  pi.on('session_shutdown', async () => {
    stopTaskFrameworkPolling()
    // 本期没有具体 task type,仅清理 disk output map。
    await _clearOutputsForTest()
    store._resetForTest()
  })
}

// 给同进程其它 extension 直接 import 用
export type { Task, TaskType, TaskStatus, TaskStateBase } from './Task.js'
export { generateTaskId, createTaskStateBase, isTerminalTaskStatus } from './Task.js'
export type { TaskStore } from './taskStore.js'
export { createTaskStore, getDefaultTaskStore, setDefaultTaskStore } from './taskStore.js'
export {
  registerTask, updateTaskState, evictTerminalTask,
  getRunningTasks, pollTasks, startTaskFrameworkPolling, stopTaskFrameworkPolling,
  POLL_INTERVAL_MS, STOPPED_DISPLAY_MS, PANEL_GRACE_MS,
} from './framework.js'
export {
  appendTaskOutput, flushTaskOutput, evictTaskOutput, cleanupTaskOutput,
  getTaskOutputDelta, getTaskOutput, getTaskOutputSize,
  initTaskOutput, initTaskOutputAsSymlink, MAX_TASK_OUTPUT_BYTES,
} from './diskOutput.js'
export { getTaskOutputDir, getTaskOutputPath } from './outputPath.js'
export type { TaskNotificationDetails, NotifyTaskTerminalOptions } from './notifications.js'
export {
  markTaskNotified, notifyTaskTerminal, TASK_NOTIFICATION_CUSTOM_TYPE,
} from './notifications.js'
```

## 终态生命周期完整时序

```
T0  spawnXxxTask()
    → registerTask(state, store)
    → store listeners 收到 snapshot
    → initTaskOutput(taskId) 写盘(可选)
T1  task 进程 / agent / runner 完成
    → updateTaskState(id, store, t => ({ ...t, status: 'completed'|'failed'|'killed', endTime }))
T2  spawnXxxTask 的 result handler 调:
    → notifyTaskTerminal(pi, store, { ...details })
       → markTaskNotified() CAS,只在第一次返回 true
       → pi.sendMessage(customType: 'tasks/notification', ...)
    → void evictTaskOutput(taskId)
T3  pollTasks 下一轮(或同步立即 evictTerminalTask):
    → terminal && notified && (无 retain 或 evictAfter 过期)→ 从 store 删除
```

## 测试

每个文件配 `*.test.ts`,Vitest globals(`describe / it / expect / vi`)。

### `Task.test.ts`

- `generateTaskId`:每个 TaskType 出正确 prefix;36^8 alphabet 范围内;一千次连续生成不冲突。
- `createTaskStateBase`:status='pending',outputFile 与 outputPath 一致,startTime 取 Date.now() (vi.setSystemTime mock)。
- `isTerminalTaskStatus`:三个 terminal、两个 non-terminal 各自正确。

### `taskStore.test.ts`

- get/set/subscribe 基本路径。
- updater 返回相同引用 → listeners 不被通知。
- updater 返回新引用 → 所有 listeners 同步收到新 snapshot。
- subscribe 后立刻 get 一致性。
- unsubscribe 后不再收到通知。
- getTask 不存在时返回 undefined。
- `_setSessionId` 后 `getSessionId` 立刻反映。
- `setDefaultTaskStore` / `getDefaultTaskStore`:未设置时 throw、设置后 get 正确、test reset 工作。

### `outputPath.test.ts`

- 首次调用 latch sessionId,后续 sessionId 切换不影响已 latch 路径。
- `_resetTaskOutputDirForTest` 后再调取新 sessionId。
- path 拼接含 `pi-tasks/<sessionId>/tasks/<taskId>.output`。

### `diskOutput.test.ts`

- 基本读写:append → flush → getTaskOutput 内容一致;append 多次按顺序保留。
- 增量读:offset=0/N/超过 size 的 delta 行为 + newOffset 推进。
- 大文件截断:超过 5GB 触发截断标记并 capped=true(用小阈值通过 vi 替换常量,或注入 mock — 实现层提供 `_setMaxBytesForTest`)。
- 并发 append:多个 append 不丢、顺序保留。
- ENOENT 容错:不存在文件 → size=0 / delta 空字符串 / output 空字符串。
- symlink 安全:在路径下放 symlink → `O_NOFOLLOW` 路径打开应失败(Unix only,Windows skip)。
- symlink 创建:`initTaskOutputAsSymlink` 已存在文件时清理重试 → 成功创建 symlink。
- symlink fallback:symlink 失败回退到 `initTaskOutput`。
- `O_EXCL`:同 id `initTaskOutput` 第二次调用失败。
- `cancel`:append 后 cancel,write 不到盘(模拟方式:DiskTaskOutput 直接实例化)。
- `_clearOutputsForTest` 在 outputs.size > 0 时返回前 settle 全部 pendingOps,outputs Map 清空。
- Windows 平台分支:`vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')`,验证 open flag 是 `'a'` / `'wx'`。

### `framework.test.ts`

- `registerTask` 写入正确 snapshot。
- `updateTaskState` 不存在 task 时 no-op 不报错。
- `updateTaskState` updater 早返回 → snapshot 引用稳定 → listener 不触发。
- `evictTerminalTask`:non-terminal、notified=false、'retain' in task 且 evictAfter 未过期 → 不动;正常路径 → 删除。
- `getRunningTasks` 过滤正确。
- `pollTasks`:running task → outputOffset 推进;terminal+notified → evict。
- `startTaskFrameworkPolling` / `stopTaskFrameworkPolling` 计时器生命周期。

### `notifications.test.ts`

- 第一次 `notifyTaskTerminal` → `pi.sendMessage` 被调用一次,带 customType / content / details / display。
- 第二次 → 不再调用。
- `markTaskNotified` 对未注册的 task no-op 返回 false。
- `triggerTurn` 透传给 sendMessage options。
- 三种 status 的 statusText 正确。
- `toolUseId` 缺省时不出现 `<tool_use_id>` 行。
- 自定义 summary 覆盖默认 description-based summary。
- worktree 字段缺省时不出现 worktree block。
- exitCode 缺省时不出现 exit_code 行。
- `registerTaskNotificationRenderer`:折叠 / 展开两路径产生预期渲染(snapshot 或 string match)。

### `index.test.ts`

集成测试,使用 fake `pi` 对象(`vi.fn` 替身):

- 注册时 `pi.registerMessageRenderer` 被调用一次,customType 正确。
- `pi.on('session_start')` / `pi.on('session_shutdown')` handler 都注册。
- 模拟 `session_start` 调用 → store sessionId 正确 + polling 启动(可观察 setInterval mock)。
- 模拟 `session_shutdown` → polling 停止 + outputs map 清空 + store 重置。
- 完整 lifecycle:registerTask → updateTaskState 到 terminal → notifyTaskTerminal → 第二次 notifyTaskTerminal 静默 → poll 后 evict。

## 后续期接入预案(spec-only,本期不写代码)

LocalShell 接入时(子项目 B),它的 `extensions/local-shell/` 会:

1. `import { generateTaskId, registerTask, updateTaskState, notifyTaskTerminal, getDefaultTaskStore, appendTaskOutput, evictTaskOutput, initTaskOutput } from '../tasks/index.js'`(或者 `'pi-tasks-extension'`,看 npm 名规)。
2. 自定义 `LocalShellTaskState extends TaskStateBase`:加 `command / result / shellCommand / kind` 等字段。
3. `spawnShellTask`:`generateTaskId('local_bash')` → `createTaskStateBase` → 扩展字段 → `registerTask`。
4. spawn ChildProcess,stdout chunk → `appendTaskOutput`。
5. 进程 exit:`updateTaskState` → terminal status → `notifyTaskTerminal` → `evictTaskOutput`。
6. `LocalShellTask: Task` 实现 `kill`,在内部调 `proc.kill()` 并 updateTaskState。

LocalAgent / Teammate / Dream 同理。详见各自后续期 spec。

## 风险与开放问题

- **fs.constants.O_NOFOLLOW 在 Windows 不存在**:用 `?? 0` fallback。Claude 已这么做,我们沿用。
- **MAX_TASK_OUTPUT_BYTES 测试**:5GB 用真盘没法测。在实现里把常量提取为 `let` + 暴露 `_setMaxBytesForTest(n)` 内部 helper,测试设小阈值跑过截断路径。
- **`pi.sendMessage` 的 `deliverAs:'nextTurn'` 行为**:文档不太详细。spec 假定它"加入下一次 prompt 的 messages 数组,不立刻抢 turn",**实现时第一步先做 fixture 验证**。
- **Pi MessageRenderer 返回类型**:从现有 `subagents/render.ts` 看是 `Text | Box`(`@earendil-works/pi-tui` 暴露)。**本扩展加 peerDep `@earendil-works/pi-tui`**,与 subagents/todo 一致。
- **session_start 触发顺序**:本扩展**必须先于**任何依赖 framework 的扩展加载,以保证 `getDefaultTaskStore` 不抛。Pi 的 `pi.extensions: ["./extensions"]` 当前按目录字典序加载,`tasks` < `todo` < `user-input` 等,**自然排在前面**。但保险起见,接入扩展应在自己的 `session_start` handler 里 lazy 取 store,而不是 module top-level。

## 验收

1. `npm install && npm test` 全绿。
2. `npm run typecheck` 全绿。
3. 手工 `pi install .` 后跑 `pi --mode rpc --no-session`,主 agent 正常启动,无加载错误。
4. 手工集成测试(spec-only,实际 task 类型接入时验证):一个伪 task 调 `notifyTaskTerminal` → RPC 模式下 stdout 见 `message_start`/`message_end` JSONL 含 `customType: "tasks/notification"`;TUI 模式见折叠 ✓ 行。
