// LocalShellTask — `local_bash` 的 Task 接口实现 + spawnLocalShell。
//
// 生命周期:
//   - exec 启动后 race 两个事件:60s timeout 或 exec 自然结束。
//   - 60s 内完成 → 返回唯一工具结果并 unregister foreground，不发 task 消息。
//   - timeout 命中 → state.isBackgrounded=true，工具返回 taskId/outputFile。
//   - 真后台自然结束 → notifyTaskTerminal(CAS) 即时更新 TUI；默认不唤醒/注入 LLM。
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
import {
  notifyTaskTerminal,
  type NotifyTaskTerminalOptions,
} from "../tasks/notifications.js";
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
  retain?: boolean;
  evictAfter?: number;
  result?: { exitCode: number | null; killed: boolean };
}

export interface SpawnLocalShellOptions {
  command: string;
  description: string;
  toolUseId?: string;
  timeoutMs?: number;
  cwd?: string;
  operations?: BashOperations;
  /** Called synchronously after registration and before the process starts. */
  onStart?: (taskId: string) => void;
  /**
   * Stream channel — invoked on each output chunk (from `onData`) so callers
   * (the task_bash tool's `execute`) can pipe live output into Pi's
   * `tool_execution_update` event via the tool's onUpdate callback.
   *
   * Snapshot includes a bounded display tail and the latest chunk. Throttle /
   * coalesce logic should live in the caller; here we forward each chunk.
   */
  onProgress?: (snap: SpawnLocalShellProgressSnapshot) => void;
}

export interface SpawnLocalShellProgressSnapshot {
  taskId: string;
  description: string;
  /** Bounded display tail; may begin with an earlier-output omission marker. */
  cumulative: string;
  /** Just the most recent chunk that triggered this snapshot. */
  chunk: string;
  /** Bytes received so far. */
  bytesReceived: number;
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
const BACKGROUND_TERMINAL_RETAIN_MS = 5 * 60_000;
const STREAM_DISPLAY_MAX_CHARS = 30_000;

interface PendingTerminalNotification {
  pi: ExtensionAPI;
  store: TaskStore;
  options: NotifyTaskTerminalOptions;
}

// Pi sendMessage steers whenever an agent is streaming, even when
// triggerTurn:false. Hold default no-wake shell completions until agent_end so
// they become ordinary immediate custom entries instead of hidden steering
// messages. This delay is bounded by the active run (unlike nextTurn, which can
// surface hours later after the next user prompt).
let _agentStreaming = false;
const _pendingTerminalNotifications = new Map<string, PendingTerminalNotification>();

/**
 * 默认 sync 等待时长 — 可被 PI_TASK_BASH_TIMEOUT_MS 覆盖(慢机器一次性调大,
 * 从源头减少“被 60s 阈值后台化 → 完成时唤醒 LLM”的频率)。每次 spawn 时
 * 读取,便于测试设置 env。
 */
function getDefaultTimeoutMs(): number {
  const raw = Number(process.env.PI_TASK_BASH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * 后台任务终态是否唤醒 LLM。默认关闭，避免每个 shell completion 都抢一个
 * agent turn；PI_TASKS_WAKE_ON_BACKGROUND=1/true 可恢复 Claude 式主动唤醒。
 */
function shouldWakeOnBackgroundTerminal(): boolean {
  const raw = process.env.PI_TASKS_WAKE_ON_BACKGROUND?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

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
  try {
    opts.onStart?.(taskId);
  } catch (e) {
    logError(e, "spawnLocalShell onStart");
  }

  // initTaskOutput fire-and-forget — appendTaskOutput 内部 O_CREAT 兜底。
  // 竞争中 appendTaskOutput 可能先建文件,此时 O_EXCL 会 EEXIST,属预期,静默忽略。
  void initTaskOutput(taskId).catch((e: unknown) => {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "EEXIST") return;
    logError(e, "initTaskOutput race");
  });

  let resultRef: { exitCode: number | null } | null = null;
  let resolved = false;
  // Keep only a bounded display tail in memory. The durable/full output lives
  // on disk; this avoids O(n²) string growth while a foreground command emits
  // a firehose (Codex likewise uses a bounded head/tail transcript).
  let streamTail = "";
  let bytesReceived = 0;

  // 同步启动 exec(使 fake.finish/emit 立即可用)
  const execPromise = ops
    .exec(opts.command, cwd, {
      onData: (buf) => {
        const chunk = buf.toString("utf8");
        bytesReceived += buf.length;
        streamTail += chunk;
        if (streamTail.length > STREAM_DISPLAY_MAX_CHARS) {
          streamTail = streamTail.slice(-STREAM_DISPLAY_MAX_CHARS);
        }
        try {
          appendTaskOutput(taskId, chunk);
        } catch (e) {
          logError(e, "spawnLocalShell appendTaskOutput");
        }
        const tailBytes = Buffer.byteLength(streamTail, "utf8");
        const omittedBytes = Math.max(0, bytesReceived - tailBytes);
        const cumulative =
          omittedBytes > 0
            ? `[${omittedBytes} bytes of earlier output omitted]\n${streamTail}`
            : streamTail;
        try {
          opts.onProgress?.({
            taskId,
            description: opts.description,
            cumulative,
            chunk,
            bytesReceived,
          });
        } catch (e) {
          logError(e, "spawnLocalShell onProgress");
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
    const timeoutMs = opts.timeoutMs ?? getDefaultTimeoutMs();
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
    // 取 store 中最新的 cancelStallWatchdog(测试可能替换过)
    const cancelFn = t?.cancelStallWatchdog ?? cancelStallWatchdog;
    cancelFn();
    try { await flushTaskOutput(taskId); } catch (e) { logError(e, "spawnLocalShell flush"); }
    const finalStatus: SpawnLocalShellResult["status"] =
      t?.status === "killed"
        ? "killed"
        : r.exitCode === 0
          ? "completed"
          : r.exitCode === null
            ? "killed"
            : "failed";
    const out = await safeRead();

    // Claude foreground Bash unregisters on completion; Codex finalizes the
    // existing exec cell. Neither emits a second task-notification. The tool
    // result below is the single source of truth for status/output.
    unregisterForegroundTask();
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
    const wake = shouldWakeOnBackgroundTerminal();
    const exitSuffix = r.exitCode !== null ? ` (exit code ${r.exitCode})` : "";
    const summary =
      finalStatus === "completed"
        ? `Background command "${opts.description}" completed${exitSuffix}`
        : finalStatus === "failed"
          ? `Background command "${opts.description}" failed${
              r.exitCode !== null ? ` with exit code ${r.exitCode}` : ""
            }`
          : `Background command "${opts.description}" was stopped`;
    deliverBackgroundTerminal(pi, store, {
      taskId,
      taskType: "local_bash",
      status: finalStatus,
      description: opts.description,
      summary,
      outputFile,
      toolUseId: opts.toolUseId,
      exitCode: r.exitCode ?? undefined,
      // Default follows Codex's non-interrupting process lifecycle. Opt-in env
      // restores Claude-style model notification/wakeup.
      triggerTurn: wake,
      display: true,
      llmVisible: wake,
      retainMs: wake ? undefined : BACKGROUND_TERMINAL_RETAIN_MS,
    });
    void evictTaskOutput(taskId);
  }

  function unregisterForegroundTask(): void {
    store.set((prev) => {
      const current = prev[taskId] as LocalShellTaskState | undefined;
      if (!current || current.isBackgrounded) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
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

function deliverBackgroundTerminal(
  pi: ExtensionAPI,
  store: TaskStore,
  options: NotifyTaskTerminalOptions,
): void {
  if (options.triggerTurn !== true && _agentStreaming) {
    _pendingTerminalNotifications.set(options.taskId, { pi, store, options });
    return;
  }
  notifyTaskTerminal(pi, store, options);
}

function flushPendingTerminalNotifications(): void {
  const pending = [..._pendingTerminalNotifications.values()];
  _pendingTerminalNotifications.clear();
  for (const item of pending) {
    notifyTaskTerminal(item.pi, item.store, item.options);
  }
}

/** Track main-agent lifecycle so non-waking completion rows never become steer messages. */
export function _setLocalShellAgentStreaming(streaming: boolean): void {
  _agentStreaming = streaming;
  if (!streaming) flushPendingTerminalNotifications();
}

/** Extension entrypoint 在 session_start 内调,把当前 pi 注入给 LocalShellTask.kill。 */
export function _bindPi(pi: ExtensionAPI): void {
  _currentPi = pi;
  _agentStreaming = false;
  _pendingTerminalNotifications.clear();
}

/** session_shutdown 内调。 */
export function _unbindPi(): void {
  _currentPi = undefined;
  _agentStreaming = false;
  _pendingTerminalNotifications.clear();
}

/** Test helper. */
export function _resetLocalShellPiBindingForTest(): void {
  _currentPi = undefined;
  _agentStreaming = false;
  _pendingTerminalNotifications.clear();
}
