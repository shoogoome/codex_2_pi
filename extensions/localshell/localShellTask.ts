// LocalShellTask — `local_bash` 的 Task 接口实现 + spawnLocalShell。
//
// 时间线见 spec §3:
//   - exec 启动后 race 两个事件:60s timeout 或 exec 自然结束。
//   - timeout 命中 → state.isBackgrounded=true,LLM 收 partial。
//   - exec 结束:read state.status,根据 'killed' / 已 background / sync race winner 三路径分发。
//
// notifyTaskTerminal 用上一期 CAS 确保多路径只发一次终态。
//
// 实现注意:spawnLocalShell 是普通函数(非 async),保证 registerTask 和 ops.exec
// 在调用方看到 Promise 之前同步执行完毕,使测试中 `await Promise.resolve()` 即可
// 读到已注册的 task 且 fake.finish 已就绪。initTaskOutput fire-and-forget,
// appendTaskOutput 内部 O_CREAT 兜底创建文件。

import {
  type ExtensionAPI,
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { createTaskStateBase, type Task, type TaskStateBase, type TaskStoreLike } from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import {
  registerTask,
  updateTaskState,
} from "../tasks/framework.js";
import {
  appendTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  initTaskOutput,
} from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { generateTaskId } from "../tasks/Task.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { emitTaskProgress } from "../tasks/progress.js";
import { logError } from "../tasks/logging.js";
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

/**
 * 启动一个 local bash 任务,返回 SpawnLocalShellResult。
 *
 * 注意:本函数是普通函数(非 async),确保 registerTask 和 ops.exec 同步执行,
 * 测试里 `await Promise.resolve()` 即可看到已注册的 task 且 fake.finish 已就绪。
 */
export function spawnLocalShell(
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalShellOptions,
): Promise<SpawnLocalShellResult> {
  const taskId = generateTaskId("local_bash");
  const cwd = opts.cwd ?? process.cwd();
  const outputFile = getTaskOutputPath(taskId);
  const abort = new AbortController();
  const ops = opts.operations ?? createLocalBashOperations();

  // 同步:启动 watchdog + 注册 task(在任何 await 之前)
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

  // Emit task_start progress to TUI/RPC (NOT into LLM context).
  emitTaskProgress(pi, {
    taskId,
    taskType: "local_bash",
    kind: "task_start",
    summary: opts.description,
    description: opts.description,
  });

  // initTaskOutput fire-and-forget — appendTaskOutput 内部 O_CREAT 兜底。
  // 竞争中 appendTaskOutput 可能先建文件,此时 O_EXCL 会 EEXIST,属预期,静默忽略。
  void initTaskOutput(taskId).catch((e: unknown) => {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "EEXIST") return;
    logError(e, "initTaskOutput race");
  });

  let resultRef: { exitCode: number | null } | null = null;
  let resolved = false;

  // 同步启动 exec(使 fake.finish/emit 立即可用)
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
        // timeout 已 resolve → 走后台 terminal 路径
        await onBackgroundedTerminal(r);
        return;
      }
      resolved = true;
      await onSyncFinish(resolve, r);
    });
  });

  // ---- helper functions (closure over taskId / store / pi / opts / outputFile) ----

  async function onSyncFinish(
    resolve: (v: SpawnLocalShellResult) => void,
    r: { exitCode: number | null },
  ): Promise<void> {
    const t = store.getTask(taskId) as LocalShellTaskState | undefined;
    if (t?.status === "killed") {
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
    // 取 store 中最新的 cancelStallWatchdog(测试可能替换过)
    const latestTask = store.getTask(taskId) as LocalShellTaskState | undefined;
    const cancelFn = latestTask?.cancelStallWatchdog ?? cancelStallWatchdog;
    cancelFn();
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
    emitTaskProgress(pi, {
      taskId,
      taskType: "local_bash",
      kind: "task_end",
      summary: `${finalStatus}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`,
      description: opts.description,
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
    // 取 store 中最新的 cancelStallWatchdog(测试可能替换过)
    const latestTask = store.getTask(taskId) as LocalShellTaskState | undefined;
    const cancelFn = latestTask?.cancelStallWatchdog ?? cancelStallWatchdog;
    cancelFn();
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
      triggerTurn: true, // LLM 已在 "Backgrounded(taskId)" 后走开，需要唤醒
    });
    emitTaskProgress(pi, {
      taskId,
      taskType: "local_bash",
      kind: "task_end",
      summary: `${finalStatus}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}`,
      description: opts.description,
      exitCode: r.exitCode ?? undefined,
    });
    void evictTaskOutput(taskId);
  }

  async function safeRead(): Promise<string> {
    try {
      return await readTruncatedOutput(taskId);
    } catch (e) {
      logError(e, "readTruncatedOutput");
      return "";
    }
  }
}

export const LocalShellTask: Task = {
  name: "LocalShellTask",
  type: "local_bash",
  async kill(taskId: string, store: TaskStoreLike): Promise<void> {
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
