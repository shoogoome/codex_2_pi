// pi-async-extension — 后台执行 + 完成回调唤醒。
//
// 存在的理由（一次真实事故）：
//   一个美术成员在跑 `for i in 1..8; do sleep 25; done`（200 秒轮询后端生图状态）。
//   同步工具调用期间它读不到任何消息 —— leader 的催促排队，leader 看它沉默，
//   判定「不回话」并把它开除了。它 200 秒后正常返回，17 个锚图全部产出。
//   同理 leader 侧的 `sleep 240` 也会把成员消息挡在门外（实测 89.5 分钟）。
//
//   根因不是谁做错了，而是**同步命令天然独占回合**。本扩展提供「提交后立刻返回、
//   完成时自动唤醒」的异步执行路径，把长等待从「占住回合」变成「回合之间」。
//
// 与既有能力的关系（重要，不要重复造）：
//   - `tasks` 扩展已提供 task store / diskOutput / notifyTaskTerminal(triggerTurn)
//     / task_list / task_status / task_kill —— 本扩展复用全部这些。
//   - `localshell` 的 `task_bash` 已有「超时转后台」能力，但它是**被动**的：
//     模型必须明知命令会超 60s 才用得上，且默认不唤醒
//     （PI_TASKS_WAKE_ON_BACKGROUND）。本扩展提供**主动**形态：一提交就返回、
//     一完成就唤醒，语义明确、不依赖环境变量。
//
// 落盘复用 tasks 的输出文件契约，所以 task_list / task_status 开箱即用。

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTasksHandle } from "../tasks/handle.js";
import { createTaskStateBase, generateTaskId, type TaskStoreLike } from "../tasks/Task.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { appendTaskOutput, evictTaskOutput, flushTaskOutput, initTaskOutput } from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { ownerFromSessionFile } from "../tasks/currentOwner.js";
import { registerChildReaper, unregisterChildReaper } from "../tasks/childReaper.js";
import { logError } from "../tasks/logging.js";

/** 每任务内存里保留的输出尾部上限；完整输出始终在 outputFile 里。 */
const TAIL_MAX_CHARS = 4_000;
/** 唤醒通知里带多少行尾部。 */
const NOTIFY_TAIL_LINES = 30;

export type AsyncStatus = "running" | "completed" | "failed" | "killed";

// Explicit details shapes per tool: without them TS infers a union of the
// success/error/hit/miss branches and rejects the tool definition.
interface AsyncBashDetails {
  action: "async_bash";
  taskId?: string;
  pid?: number;
  status?: "running" | "failed";
}

interface AsyncStatusDetails {
  action: "async_status";
  taskId?: string;
  status?: AsyncStatus | "unknown";
  exitCode?: number;
  elapsedMs?: number;
  outputFile?: string;
  tasks?: { taskId: string; status: AsyncStatus; label?: string }[];
}

interface AsyncKillDetails {
  action: "async_kill";
  taskId?: string;
  wasRunning?: boolean;
}

interface AsyncTaskState {
  id: string;
  command: string;
  cwd: string;
  label?: string;
  child: ReturnType<typeof spawn>;
  pid?: number;
  /** 内存中的输出尾部；完整输出在 outputFile。 */
  tail: string;
  bytesReceived: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  startedAt: number;
  endedAt?: number;
  killed: boolean;
  /** 是否在完成时唤醒模型。 */
  notify: boolean;
  /**
   * 发起该任务的 teammate（`name@team`），leader 发起时为 undefined。
   * task_status 把它渲染成 `owner:` 行，便于回答「这个后台任务为什么没被
   * 回收」—— 只有记到 owner 的任务才会在成员被 kill 时一并终止。
   */
  ownerAgentId?: string;
}

/**
 * 进程内注册表 —— 与 tasks 的 store 并列。
 *
 * 为什么不用 module 级 Map：teammate 子会话在独立 jiti realm 里加载扩展，
 * module 单例不共享（同一个坑在 approvalGate 上踩过一次，leader 写文件被
 * 误判成成员）。globalThis + Symbol.for 让所有 realm 看到同一份。
 */
const REGISTRY_KEY = Symbol.for("pi.async.tasks");

function registry(): Map<string, AsyncTaskState> {
  const target = globalThis as unknown as Record<symbol, Map<string, AsyncTaskState> | undefined>;
  let value = target[REGISTRY_KEY];
  if (!value) {
    value = new Map<string, AsyncTaskState>();
    target[REGISTRY_KEY] = value;
  }
  return value;
}

export function statusOf(task: AsyncTaskState): AsyncStatus {
  if (task.endedAt === undefined) return "running";
  if (task.killed) return "killed";
  return task.exitCode === 0 ? "completed" : "failed";
}

export function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return `… (${lines.length - maxLines} earlier lines omitted)\n` + lines.slice(-maxLines).join("\n");
}

export function elapsedOf(task: AsyncTaskState): number {
  return (task.endedAt ?? Date.now()) - task.startedAt;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}

/**
 * 启动一个后台进程并立即返回（不 await 子进程退出）。
 *
 * 退出回调里 notifyTaskTerminal(triggerTurn:true) —— 会话空闲则直接开新轮，
 * 忙则进队列（不丢）。
 */
export function spawnAsyncShell(
  pi: ExtensionAPI,
  store: TaskStoreLike,
  opts: {
    command: string;
    cwd: string;
    label?: string;
    notify: boolean;
    /** Owning teammate (`name@team`), resolved from the CALLER's session file. */
    ownerAgentId?: string;
  },
): AsyncTaskState {
  const id = generateTaskId("async_shell");
  const outputFile = getTaskOutputPath(id);
  const ownerAgentId = opts.ownerAgentId;
  const child = spawn("/bin/bash", ["-lc", opts.command], {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group, so killing can target the GROUP rather than one pid.
    // Without this a `nohup … &` / `cmd1 && cmd2` grandchild survives the kill
    // (pi's own bash tool does the same, then killProcessTree(-pid)).
    detached: process.platform !== "win32",
  });

  const task: AsyncTaskState = {
    id,
    command: opts.command,
    cwd: opts.cwd,
    label: opts.label,
    child,
    pid: child.pid,
    tail: "",
    bytesReceived: 0,
    startedAt: Date.now(),
    killed: false,
    notify: opts.notify,
    ownerAgentId,
  };
  registry().set(id, task);

  // 注册进 tasks store —— task_list / task_status / task_kill 立刻可见。
  // description 用 label/命令首行，task_list 里可读。
  const description =
    opts.label ??
    (opts.command.split(/\r?\n/)[0] ?? opts.command).slice(0, 80);
  // Register into the SAME store this realm reads from the tasks handle.
  // NOTE: a teammate's own session has its OWN tasks extension instance, so a
  // task it starts lands in a DIFFERENT store object than the leader's. Global
  // child reapers (tasks/childReaper.js) are what make a team kill reach it.
  registerTask(
    {
      ...createTaskStateBase({
        id,
        type: "async_shell",
        description,
        outputFile,
        ownerAgentId,
      }),
      status: "running",
    } as never,
    store as never,
  );

  void initTaskOutput(id).catch((e: unknown) => {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "EEXIST") return;
    logError(e, "async initTaskOutput");
  });

  const onData = (buf: Buffer): void => {
    const chunk = buf.toString("utf8");
    task.bytesReceived += buf.length;
    task.tail += chunk;
    if (task.tail.length > TAIL_MAX_CHARS) task.tail = task.tail.slice(-TAIL_MAX_CHARS);
    try {
      appendTaskOutput(id, chunk);
    } catch (e) {
      logError(e, "async appendTaskOutput");
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const finish = (): void => {
    if (task.endedAt !== undefined) return;
    task.endedAt = Date.now();
    if (task.exitCode === undefined) task.exitCode = child.exitCode;
    task.signal = child.signalCode;
    const status = statusOf(task);
    const terminal = status === "running" ? "completed" : status;

    // This runs from a ChildProcess event, i.e. OUTSIDE any agent turn, and
    // possibly AFTER the session was replaced or torn down (--print exits when
    // the prompt completes; the platform rotates sessions). Anything that
    // touches the session here can throw "This extension ctx is stale after
    // session replacement or reload" — and an exception thrown from a child
    // process handler is an unhandled crash, not a tool error. So: never
    // resolve the store lazily here, and treat every step as best-effort.
    try {
      updateTaskState<never>(id, store as never, (cur) => ({
        ...(cur as Record<string, unknown>),
        status: terminal,
        endTime: task.endedAt,
      }) as never);
    } catch (e) {
      logError(e, "async updateTaskState");
    }

    if (!task.notify) return;
    void flushTaskOutput(id).catch((e: unknown) => logError(e, "async flushTaskOutput"));

    const name = opts.label ?? description;
    const verdict = status === "completed" ? "完成" : status === "killed" ? "被终止" : "失败";
    const exitSuffix =
      task.exitCode !== undefined && task.exitCode !== null ? `（exit ${task.exitCode}）` : "";
    try {
      notifyTaskTerminal(pi, store as never, {
        taskId: id,
        taskType: "async_shell",
        status: terminal,
        description: name,
        summary: `[async] ${name} ${verdict}${exitSuffix} · 耗时 ${formatDuration(elapsedOf(task))}`,
        outputFile,
        exitCode: task.exitCode ?? undefined,
        finalMessage: tailLines(task.tail, NOTIFY_TAIL_LINES),
        // 这就是「回调唤醒」：空闲会话立即开新轮，忙则排队不丢。
        triggerTurn: true,
        display: true,
        retainMs: 5 * 60_000,
      });
    } catch (e) {
      // A dead session has nobody to wake; the output file still holds the
      // result. Failing here must not crash the process.
      logError(e, "async notifyTaskTerminal");
    }
    // 已完成的后台任务不再需要 task 面板占位；输出已落盘。
    void evictTaskOutput(id).catch(() => {});
  };

  child.on("exit", finish);
  child.on("error", (err) => {
    try {
      appendTaskOutput(id, `\n[spawn error] ${err.message}\n`);
    } catch {
      /* ignore */
    }
    task.exitCode = 1;
    finish();
  });

  return task;
}

/** 终止一个后台任务：SIGTERM → 5 秒后 SIGKILL。 */
export async function killAsyncTask(id: string): Promise<boolean> {
  const task = registry().get(id);
  if (!task) return false;
  if (task.endedAt !== undefined) return true;
  task.killed = true;
  signalTaskTree(task.child, "SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      signalTaskTree(task.child, "SIGKILL");
      resolve();
    }, 5_000);
    t.unref?.();
    task.child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  return true;
}

/**
 * Signal the spawned shell's whole process group, falling back to the single
 * pid.
 *
 * `detached:true` at spawn time made the shell a group leader, so `-pid`
 * reaches grandchildren too. A command like `nohup server.js &` would otherwise
 * survive (the shell exits, the grandchild is reparented to init and keeps
 * holding the port). Mirrors pi core's `killProcessTree`.
 */
function signalTaskTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid === undefined) {
    // Never spawned (spawn error path): nothing to signal.
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Group kill unavailable (already reaped, or the group leader changed).
  }
  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

/**
 * Stop every tracked child owned by `agentId`. Registered as a process-global
 * child reaper so a teammate kill reaches it regardless of which session realm
 * spawned the child (see tasks/childReaper.ts for the measured store split).
 */
export async function killAsyncTasksOwnedBy(agentId: string): Promise<number> {
  const mine = [...registry().values()].filter(
    (t) => t.ownerAgentId === agentId && t.endedAt === undefined,
  );
  await Promise.all(
    mine.map(async (t) => {
      try {
        await killAsyncTask(t.id);
      } catch (e) {
        logError(e, "async killAsyncTasksOwnedBy");
      }
    }),
  );
  return mine.length;
}

/**
 * 注册为 tasks 的 task type，使 `task_kill` / `task_status` 也能操作后台任务。
 *
 * 用独立类型 `async_shell`（不是 `local_bash`）：localshell 的 task_bash 也注册
 * `local_bash`，两个扩展注册同一类型会互相覆盖 kill 实现（registry last-wins），
 * 让 `task_kill` 对其中一个失效。
 */
export const AsyncShellTask = {
  name: "AsyncShellTask",
  type: "async_shell" as const,
  async kill(taskId: string): Promise<void> {
    await killAsyncTask(taskId);
  },
  describe(taskId: string): string[] | undefined {
    const task = registry().get(taskId);
    if (!task) return undefined;
    const st = statusOf(task);
    const lines = [
      `async task: ${task.label ?? task.command.slice(0, 60)}`,
      st === "running"
        ? `state: running for ${formatDuration(elapsedOf(task))}`
        : `state: ${st} (took ${formatDuration(elapsedOf(task))})`,
    ];
    if (task.pid) lines.push(`pid: ${task.pid}`);
    // Ownership drives teammate-kill reaping; surface it so "why wasn't this
    // reaped?" is answerable from task_status alone.
    lines.push(`owner: ${task.ownerAgentId ?? "leader"}`);
    lines.push(
      task.notify
        ? st === "running"
          ? "wake-up: on completion it notifies and wakes the session automatically — do NOT poll or sleep"
          : "wake-up: already delivered"
        : "wake-up: disabled (notify=never) — check with async_status",
    );
    return lines;
  },
};

const AsyncBashParams = Type.Object({
  command: Type.String({ description: "Shell command to run in the background." }),
  label: Type.Optional(
    Type.String({ description: "Short human-readable label used in the completion notice." }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory. Defaults to the session cwd." }),
  ),
  notify: Type.Optional(
    Type.Union([Type.Literal("on_complete"), Type.Literal("never")], {
      description:
        "on_complete (default) wakes you when the command finishes; never runs it silently.",
    }),
  ),
});

const AsyncStatusParams = Type.Object({
  task_id: Type.Optional(Type.String({ description: "Background task id. Omit to list all." })),
  tail: Type.Optional(
    Type.Number({ description: "Trailing output lines to return (default 30, max 500)." }),
  ),
});

const AsyncKillParams = Type.Object({
  task_id: Type.String({ description: "Background task id from async_bash." }),
});

export default function asyncExtension(pi: ExtensionAPI): void {
  /**
   * The tasks store, captured ONCE while the session is alive.
   *
   * Deliberately NOT `lazyTaskStore(pi)`: that Proxy re-resolves the handle on
   * every property access, and a background command can finish after the
   * session was replaced or torn down (pi --print exits when the prompt
   * completes; the platform rotates sessions). Resolving then throws
   * "This extension ctx is stale after session replacement or reload" from a
   * ChildProcess handler — an unhandled crash, reproduced end-to-end.
   *
   * Capturing the concrete object keeps the completion path working: the store
   * is a plain object, so writes after session teardown are harmless.
   */
  let captured: TaskStoreLike | undefined;

  pi.on("session_start", () => {
    try {
      const handle = getTasksHandle(pi);
      captured = handle.store;
      handle.registerTaskType("async_shell", AsyncShellTask as never);
    } catch (e) {
      // 非致命：async 工具本身仍可用，只是不接 task_kill / task 面板。
      logError(e, "async session_start");
    }
    // Process-global so a teammate kill can stop children this realm spawned —
    // the teammate's task lives in ITS OWN session's TaskStore, out of reach of
    // the leader-side store sweep. Keyed so a reload replaces, not accumulates.
    registerChildReaper("async", killAsyncTasksOwnedBy);
  });

  pi.on("session_shutdown", async () => {
    unregisterChildReaper("async");
    const running = [...registry().values()].filter((t) => t.endedAt === undefined);
    await Promise.all(
      running.map(async (t) => {
        try {
          t.killed = true;
          signalTaskTree(t.child, "SIGTERM");
        } catch {
          /* ignore */
        }
      }),
    );
    registry().clear();
  });

  // ---------- ① async_bash ----------

  pi.registerTool<typeof AsyncBashParams, AsyncBashDetails>({
    name: "async_bash",
    label: "Async bash",
    description:
      "Run a shell command in the BACKGROUND and return immediately with a task id. The command keeps running after this tool returns; when it finishes the result is delivered back to you automatically and wakes this session if it is idle." +
      "\n\n## Use this instead of blocking waits\n\n" +
      "- **Never** run `sleep N` or a `for …; do sleep …; done` poll loop in the foreground: while a synchronous command runs you cannot receive messages, and the other side sees silence that looks like a hang." +
      "- Anything expected to take more than ~30 seconds (polling a remote job, a long build, waiting for a file to appear, waiting for a coordinator to publish something) belongs here." +
      "- After submitting, END YOUR TURN (or continue with other work). Do not poll. You will be woken with the exit code, the tail of the output, and the full output file path." +
      "\n\n## Notes\n\n" +
      "- Output is appended to a task output file; only the tail is kept in memory. Read the file for the full log." +
      "- Inspect with `async_status`, stop with `async_kill` (or `task_kill`).",

    parameters: AsyncBashParams,
    promptSnippet:
      "Run a shell command in the background; get woken with its result when it finishes",
    executionMode: "parallel",
    async execute(_callId, raw, _signal, _onUpdate, ctx) {
      const { command, label, cwd, notify } = raw as {
        command: string;
        label?: string;
        cwd?: string;
        notify?: "on_complete" | "never";
      };
      if (typeof command !== "string" || command.trim().length === 0) {
        return {
          content: [{ type: "text" as const, text: "command must be non-empty" }],
          isError: true,
          details: { action: "async_bash" as const },
        };
      }
      // Resolve here (inside a live turn) rather than in the completion path.
      const store = captured ?? getTasksHandle(pi).store;
      captured = store;
      try {
        const task = spawnAsyncShell(pi, store, {
          command,
          cwd: cwd ?? ctx?.cwd ?? process.cwd(),
          label,
          notify: notify !== "never",
          // Attribute the child to the calling teammate, read from the
          // session file (realm-safe) — NOT from AsyncLocalStorage, which is
          // empty inside a teammate sub-session's tool-call realm.
          ownerAgentId: ownerFromSessionFile(
            (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } } | undefined)
              ?.sessionManager?.getSessionFile?.(),
          ),
        });
        const text =
          `started (taskId=${task.id}${task.pid ? `, pid=${task.pid}` : ""}).\n` +
          `output: ${getTaskOutputPath(task.id)}\n` +
          (task.notify
            ? "You will be notified automatically when it finishes — end your turn or do other work; do not poll."
            : "notify=never: check it with async_status.");
        return {
          content: [{ type: "text" as const, text }],
          details: {
            action: "async_bash" as const,
            taskId: task.id,
            pid: task.pid,
            status: "running" as const,
          },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `failed to start: ${(e as Error)?.message ?? String(e)}`,
            },
          ],
          isError: true,
          details: { action: "async_bash" as const, status: "failed" as const },
        };
      }
    },
  });

  // ---------- ② async_status ----------

  pi.registerTool<typeof AsyncStatusParams, AsyncStatusDetails>({
    name: "async_status",
    label: "Async status",
    description:
      "Check background tasks started with `async_bash`: state, exit code, elapsed time, and the tail of their output. Omit task_id to list every background task in this session." +
      "\n\nUse this when you need to know whether a job already finished — for example before starting a duplicate. You do NOT need it for ordinary waiting: completion is delivered to you automatically.",
    parameters: AsyncStatusParams,
    promptSnippet: "Check background async_bash tasks: state, exit code, output tail",
    executionMode: "parallel",
    async execute(_callId, raw) {
      const { task_id, tail } = raw as { task_id?: string; tail?: number };
      const maxLines = Math.min(Math.max(tail ?? 30, 1), 500);

      if (!task_id) {
        const all = [...registry().values()].sort((a, b) => b.startedAt - a.startedAt);
        if (all.length === 0) {
          return {
            content: [{ type: "text" as const, text: "no background tasks in this session." }],
            details: { action: "async_status" as const, tasks: [] },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: all
                .map(
                  (t) =>
                    `- ${t.id}  [${statusOf(t)}]  ${formatDuration(elapsedOf(t))}  ` +
                    `${t.label ?? t.command.slice(0, 60)}`,
                )
                .join("\n"),
            },
          ],
          details: {
            action: "async_status" as const,
            tasks: all.map((t) => ({ taskId: t.id, status: statusOf(t), label: t.label })),
          },
        };
      }

      const task = registry().get(task_id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: `unknown background task: ${task_id}` }],
          isError: true,
          details: { action: "async_status" as const, status: "unknown" as const },
        };
      }
      const st = statusOf(task);
      await flushTaskOutput(task.id).catch((e: unknown) => logError(e, "async_status flush"));
      const head =
        `${st} · ${formatDuration(elapsedOf(task))}` +
        `${task.exitCode !== undefined && task.exitCode !== null ? ` · exit ${task.exitCode}` : ""}` +
        `${task.pid ? ` · pid ${task.pid}` : ""}` +
        `${task.label ? ` · ${task.label}` : ""}`;
      const body = task.tail.trim().length > 0 ? `\n${tailLines(task.tail, maxLines)}` : "";
      return {
        content: [{ type: "text" as const, text: head + body }],
        details: {
          action: "async_status" as const,
          taskId: task.id,
          status: st,
          exitCode: task.exitCode ?? undefined,
          elapsedMs: elapsedOf(task),
          outputFile: getTaskOutputPath(task.id),
        },
      };
    },
  });

  // ---------- ③ async_kill ----------

  pi.registerTool<typeof AsyncKillParams, AsyncKillDetails>({
    name: "async_kill",
    label: "Async kill",
    description:
      "Stop a background task started with `async_bash` (SIGTERM, then SIGKILL after 5s). The task is marked killed; its output file is kept so you can still read what it produced." +
      "\n\nNote: `task_kill` also stops these tasks (they are registered in the task store); `async_kill` is the direct form and reports the outcome inline.",
    parameters: AsyncKillParams,
    promptSnippet: "Stop a background async_bash task",
    executionMode: "parallel",
    async execute(_callId, raw) {
      const { task_id } = raw as { task_id: string };
      const task = registry().get(task_id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: `unknown background task: ${task_id}` }],
          isError: true,
          details: { action: "async_kill" as const },
        };
      }
      const wasRunning = task.endedAt === undefined;
      await killAsyncTask(task_id);
      return {
        content: [
          {
            type: "text" as const,
            text: wasRunning ? `stopped ${task_id}` : `${task_id} had already finished`,
          },
        ],
        details: { action: "async_kill" as const, taskId: task_id, wasRunning },
      };
    },
  });
}

/** Test-only: tear down every tracked child + clear the registry. */
export function _resetAsyncRegistryForTest(): void {
  for (const t of registry().values()) {
    signalTaskTree(t.child, "SIGKILL");
  }
  registry().clear();
}

/** Test-only: internals without booting a pi session. */
export const _internals = {
  spawnAsyncShell,
  killAsyncTask,
  statusOf,
  tailLines,
  formatDuration,
  registry,
};
