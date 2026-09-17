// Task framework public types & helpers.
//
// 公共类型与生成器 — 等价 Claude `claude/Task.ts`,但去掉了 React/AppState 依赖。
//
// 各 task type(LocalShell / LocalAgent / Teammate / Dream / ...)在自己的文件里
// `extends TaskStateBase` 加自己的字段,然后通过 framework 的 `registerTask` /
// `updateTaskState` / `evictTerminalTask` 接入。

import { randomBytes } from "node:crypto";

/**
 * 所有支持的 task 类型。
 *
 * 本仓库本期只实现框架内核,具体 task type 留给后续期。
 * 占位类型(`remote_agent` / `local_workflow` / `monitor_mcp`)因依赖
 * Anthropic 服务端或 Claude 私有 feature,本仓库不实现实体,但保留枚举。
 */
export type TaskType =
  | "local_bash"
  | "local_agent"
  | "in_process_teammate"
  | "dream"
  | "remote_agent"
  | "local_workflow"
  | "monitor_mcp"
  /**
   * Background shell jobs submitted by the `async` extension's `async_bash`.
   *
   * Separate from `local_bash` on purpose: `localshell`'s `task_bash` also
   * registers `local_bash`, and two extensions registering the same type would
   * silently override each other's `kill` (the registry warns and last-wins),
   * breaking `task_kill` for whichever lost. Distinct types keep both alive.
   */
  | "async_shell";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

/**
 * Terminal status:已完成 / 失败 / 被杀 — task 不会再有状态变化。
 *
 * 用于通知 CAS、eviction 守卫、跨 task type 通用判定。
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

/**
 * 所有 task state 共享的字段。具体 task type 在此基础上加自己的字段。
 */
export interface TaskStateBase {
  id: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  toolUseId?: string;
  startTime: number;
  endTime?: number;
  /** 输出文件绝对路径 — 跨 task type 的统一契约。具体内容由各 type 自己负责写入。 */
  outputFile: string;
  /** 已被消费的字节数 — framework `pollTasks` 推进。 */
  outputOffset: number;
  /** 终态通知是否已发出 — markTaskNotified CAS 控制。 */
  notified: boolean;
}

/**
 * 各 task type 提供的"操作"对象 — 当前框架只需要 kill,与 Claude 一致。
 *
 * 注意 store 是 forward-declared 类型,具体定义在 `taskStore.ts`,这里只做接口声明。
 */
export interface Task {
  name: string;
  type: TaskType;
  kill(taskId: string, store: TaskStoreLike): Promise<void>;
  /**
   * Optional diagnostic lines surfaced by `task_status` (after the status head,
   * before the output delta). Implemented per task type so `tasks` stays
   * independent of concrete type internals — the concrete type knows which of
   * its fields are worth reporting, the generic tool just prints them.
   *
   * Motivation: "did the teammate hang, or is it just inside a long command?"
   * is not answerable from status + output alone. Without this the caller has
   * to guess from message latency and gets it wrong (misdiagnosing a 200s bash
   * poll as a dead teammate).
   */
  describe?(taskId: string, store: TaskStoreLike): string[] | undefined;
}

// 减小循环 import:此处只需要 set/getTask 两个能力的形状,完整接口在 taskStore.ts。
export interface TaskStoreLike {
  getTask(id: string): TaskStateBase | undefined;
  set(updater: (prev: Record<string, TaskStateBase>) => Record<string, TaskStateBase>): void;
}

/**
 * Task ID 前缀表 — 与 Claude 完全一致,持久化兼容。
 *
 * 加新 task type 时同步在这里和 `TaskType` 上添加。
 */
const TASK_ID_PREFIXES: Record<TaskType, string> = {
  local_bash: "b", // 与 Claude 持久化兼容
  local_agent: "a",
  remote_agent: "r",
  in_process_teammate: "t",
  local_workflow: "w",
  monitor_mcp: "m",
  dream: "d",
  async_shell: "b", // 复用 bash 前缀:它就是一个后台 bash 任务
};

// 36^8 ≈ 2.8 万亿组合,足够防 sandbox symlink 攻击的 brute-force。
// 仅小写字母 + 数字,case-insensitive-safe(macOS HFS / Windows NTFS 路径都安全)。
const TASK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function generateTaskId(type: TaskType): string {
  const prefix = TASK_ID_PREFIXES[type] ?? "x";
  const bytes = randomBytes(8);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += TASK_ID_ALPHABET[bytes[i]! % TASK_ID_ALPHABET.length];
  }
  return id;
}

/**
 * 创建 base state — 默认 status='pending',startTime=now,outputFile 由调用方传。
 *
 * outputFile 不在这里通过 `getTaskOutputPath(id)` 自动算 — 因为本文件不应循环 import
 * `outputPath.js`。spawn 函数自己算后传入。
 */
export function createTaskStateBase(args: {
  id: string;
  type: TaskType;
  description: string;
  outputFile: string;
  toolUseId?: string;
}): TaskStateBase {
  return {
    id: args.id,
    type: args.type,
    status: "pending",
    description: args.description,
    toolUseId: args.toolUseId,
    startTime: Date.now(),
    outputFile: args.outputFile,
    outputOffset: 0,
    notified: false,
  };
}
