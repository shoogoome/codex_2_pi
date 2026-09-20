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

/**
 * 一次交付里最多带多少条被抑制的完成记录。
 *
 * 上限存在的理由：待交付列表会跨会话轮换写进 session 文件，无界增长会让
 * 每次交付的注入体积不可控（一个跑了很久的会话可能积累几十条）。
 * 超出时保留**最新**的若干条 —— 旧结果的可操作性最低。
 */
const PENDING_DELIVERY_LIMIT = 50;

/** 交付记账快照的 custom entry 类型（type="custom"，不参与 LLM 上下文）。 */
const DELIVERY_ENTRY_TYPE = "async/aborted-completions";
/** 交付汇总的 custom message 类型（进 LLM 上下文，给模型看）。 */
const DELIVERY_SUMMARY_CUSTOM_TYPE = "async/aborted-completions-summary";

export type AsyncStatus = "running" | "completed" | "failed" | "killed";

/**
 * 一条被抑制（未唤醒）的完成记录 —— 交付汇总的数据来源。
 *
 * 全部字段都是「已发生的事实」，不含任何动作指令：模型据此自行判断是否需要
 * 处理，而不是被要求重跑或重读。
 */
export interface SuppressedResult {
  taskId: string;
  /** 提交时给的 label；缺省时交付用命令首行代替。 */
  label?: string;
  command: string;
  status: Exclude<AsyncStatus, "running">;
  exitCode?: number | null;
  outputFile: string;
  finishedAt: number;
}

/**
 * 会话级的唤醒策略句柄，由扩展体在 `session_start` 时构造并交给
 * `spawnAsyncShell`。
 *
 * 为什么不在 spawn 时就决定要不要唤醒：用户可能在**任务提交之后**才按停止，
 * 判定必须发生在完成时刻。所以这里传的是「查询 + 记账」两个回调，而不是一个
 * 布尔值。
 */
export interface WakeupControl {
  /** 当前这一轮是否由用户中止结束、且此后用户尚未发起新对话。 */
  isUserAborted(): boolean;
  /** 记下一次被抑制的完成，供下次用户发话时交付。 */
  recordSuppressed(result: SuppressedResult): void;
}

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

/** 终态的中文短标签。交付汇总与通知文案共用，避免两处措辞漂移。 */
export function terminalStatusText(status: Exclude<AsyncStatus, "running">): string {
  switch (status) {
    case "completed":
      return "完成";
    case "failed":
      return "失败";
    case "killed":
      return "被终止";
  }
}

/**
 * 构造交给模型的交付汇总（纯文本）。
 *
 * 措辞约束（来自 spec）：
 *   - MUST 含每条的任务标识、标签或命令摘要、终态、退出码（若有）、输出文件位置。
 *   - MUST NOT 引导模型直接重跑任务，也 MUST NOT 引导重读被裁剪的历史。
 *   - 明确告知「这是既有事实、不是新指令」，把是否处理交回模型判断。
 */
export function buildSuppressedSummary(batch: readonly SuppressedResult[]): string {
  const lines: string[] = [];
  lines.push("【后台异步任务结果｜用户中止之后完成的】");
  lines.push(
    "这些任务在用户中止上一次响应之后结束，因此当时没有唤醒会话。现在一并告知，供你自行判断是否需要处理。",
  );
  lines.push("");
  for (const item of batch) {
    const name = item.label ?? (item.command.split(/\r?\n/)[0] ?? item.command).slice(0, 80);
    const exit =
      item.exitCode !== undefined && item.exitCode !== null ? `（exit ${item.exitCode}）` : "";
    lines.push(
      `- ${item.taskId}｜${name}｜${terminalStatusText(item.status)}${exit}｜输出：${item.outputFile}`,
    );
  }
  lines.push("");
  lines.push(
    "以上是已经发生的事实，不是新的指令。与用户当前请求无关时可以直接忽略，不必专门回应；相关时再按需要读取上面列出的输出文件。",
  );
  return lines.join("\n");
}

/** 交付汇总作为 custom message 的形状（`before_agent_start` 的返回值）。 */
export interface DeliveryMessage {
  customType: string;
  content: string;
  display: boolean;
  details: {
    kind: "aborted-completion-summary";
    taskIds: string[];
    deliveredAt: number;
  };
}

/**
 * 「用户中止纪元」状态机。
 *
 * 抽成工厂而不是直接写在扩展体里：置位/解除时机与交付一次性是本变更最易写错的
 * 地方，必须能被单测直接驱动，不必真起子进程。
 */
export interface AbortEpoch {
  /** 交给 spawnAsyncShell 的唤醒策略（完成时刻才调 isUserAborted）。 */
  readonly wakeup: WakeupControl;
  /**
   * 每轮 `agent_end` 调用。取最后一条 assistant 的 `stopReason`，
   * 仅在严格等于 `"aborted"` 时置位（fail-open：拿不准就不抑制）。
   */
  noteAgentEnd(event: unknown): void;
  /**
   * 用户/平台真正发起新一轮：解除中止态（恢复唤醒），并一次性产出待交付汇总。
   * 由 `before_agent_start` 调用 —— 不用 `agent_start`，后者在续跑时也会发。
   */
  beginUserTurn(): { message: DeliveryMessage } | undefined;
  /** 从会话 entry 读回「已交付」记账，避免 session/load 后重复交付。 */
  restoreDelivered(ctx: unknown): void;
  /** 会话结束：中止态与待交付列表都是本会话的派生态，不得泄到下一个。 */
  reset(): void;
  /** 测试用只读快照。 */
  snapshot(): { userAborted: boolean; pending: SuppressedResult[]; delivered: string[] };
}

/**
 * 创建中止纪元状态机。
 *
 * @param appendEntry 交付记账写入会话（`custom` entry，不参与 LLM 上下文）。
 *                    缺省时仅内存记账。
 */
export function createAbortEpoch(
  appendEntry?: (customType: string, data: unknown) => void,
): AbortEpoch {
  let userAborted = false;
  let pending: SuppressedResult[] = [];
  let delivered = new Set<string>();

  return {
    wakeup: {
      isUserAborted: () => userAborted,
      recordSuppressed: (result) => {
        pending.push(result);
        // 保留最新的若干条：旧结果的可操作性最低，且该列表会跨轮次存在。
        if (pending.length > PENDING_DELIVERY_LIMIT) {
          pending = pending.slice(-PENDING_DELIVERY_LIMIT);
        }
      },
    },

    noteAgentEnd(event) {
      const messages = (event as { messages?: unknown } | undefined)?.messages;
      if (!Array.isArray(messages)) return;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
        if (msg?.role !== "assistant") continue;
        if (msg.stopReason === "aborted") userAborted = true;
        return;
      }
    },

    beginUserTurn() {
      // 先解除：新一轮已经真的开始，之后完成的任何任务回到正常唤醒语义。
      userAborted = false;
      if (pending.length === 0) return undefined;
      const batch = pending
        .filter((item) => !delivered.has(item.taskId))
        .sort((a, b) => a.finishedAt - b.finishedAt);
      // 无论是否产出内容都清空：重复项已由 delivered 记账拦住，不必再轮询。
      pending = [];
      if (batch.length === 0) return undefined;
      for (const item of batch) delivered.add(item.taskId);
      const taskIds = batch.map((item) => item.taskId);
      try {
        appendEntry?.(DELIVERY_ENTRY_TYPE, { deliveredAt: Date.now(), taskIds });
      } catch {
        // 记账写不进去不影响本轮交付；最坏情况是 reload 后重复告知一次。
      }
      return {
        message: {
          customType: DELIVERY_SUMMARY_CUSTOM_TYPE,
          content: buildSuppressedSummary(batch),
          display: false,
          details: { kind: "aborted-completion-summary", taskIds, deliveredAt: Date.now() },
        },
      };
    },

    restoreDelivered(ctx) {
      const entries = (
        ctx as { sessionManager?: { getEntries?: () => unknown[] } } | undefined
      )?.sessionManager?.getEntries?.();
      if (!Array.isArray(entries)) return;
      const restored = new Set<string>();
      for (const entry of entries) {
        const e = entry as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
        if (e?.type !== "custom" || e.customType !== DELIVERY_ENTRY_TYPE) continue;
        const ids = (e.data as { taskIds?: unknown } | undefined)?.taskIds;
        if (!Array.isArray(ids)) continue;
        for (const id of ids) if (typeof id === "string") restored.add(id);
      }
      if (restored.size > 0) delivered = restored;
    },

    reset() {
      userAborted = false;
      pending = [];
      delivered = new Set<string>();
    },

    snapshot() {
      return { userAborted, pending: [...pending], delivered: [...delivered] };
    },
  };
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
    /**
     * 唤醒策略。缺省时不抑制（等同未中止）。
     *
     * 判定延迟到**完成时刻**才做：用户可能在任务提交之后才按下停止。
     */
    wakeup?: WakeupControl;
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

    // 「用户中止后不得被后台任务拉起」——抑制判定必须在完成时刻做，因为用户可能
    // 在任务提交之后才按停止。抑制时改用 triggerTurn:false（且不传 deliverAs）:
    // 命中 sendCustomMessage 的最后一个分支 —— 内容进上下文、写进 session 文件，
    // 但既不入队也不开会话。结果因此不会丢，只是推迟到用户下次发话时交付。
    // llmVisible:false 让原始 XML 不进模型上下文（由 before_agent_start 的汇总承担）。
    const suppressed = opts.wakeup?.isUserAborted() === true;
    try {
      notifyTaskTerminal(pi, store as never, {
        taskId: id,
        taskType: "async_shell",
        status: terminal,
        description: name,
        summary: suppressed
          ? `[async] ${name} ${verdict}${exitSuffix} · 耗时 ${formatDuration(elapsedOf(task))}（用户已中止，未唤醒）`
          : `[async] ${name} ${verdict}${exitSuffix} · 耗时 ${formatDuration(elapsedOf(task))}`,
        outputFile,
        exitCode: task.exitCode ?? undefined,
        finalMessage: suppressed ? undefined : tailLines(task.tail, NOTIFY_TAIL_LINES),
        // 抑制时 false：不开新轮、不入队；非抑制时保持既有唤醒语义。
        triggerTurn: !suppressed,
        display: !suppressed,
        ...(suppressed ? { llmVisible: false } : {}),
        retainMs: 5 * 60_000,
      });
    } catch (e) {
      // A dead session has nobody to wake; the output file still holds the
      // result. Failing here must not crash the process.
      logError(e, "async notifyTaskTerminal");
    }
    if (suppressed) {
      // 记账，供 before_agent_start 交付。放在 notify 之后：即使 notify 抛错，
      // 结果也不会因此从交付列表里消失（输出文件仍在磁盘上）。
      try {
        opts.wakeup?.recordSuppressed({
          taskId: id,
          ...(opts.label ? { label: opts.label } : {}),
          command: opts.command,
          status: terminal,
          exitCode: task.exitCode ?? undefined,
          outputFile,
          finishedAt: task.endedAt,
        });
      } catch (e) {
        logError(e, "async recordSuppressed");
      }
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

  /**
   * 「用户中止纪元」状态机（见 createAbortEpoch 的注释）。
   *
   * 置位：`agent_end` 时本轮最后一条 assistant 的 `stopReason === "aborted"`。
   * 解除：`before_agent_start`（用户/平台真正发起新一轮）。
   *
   * **为什么不能用 `agent_start` 解除**：`agent.continue()`（中止后由残留队列
   * 驱动的续跑）也会 emit `agent_start`（pi-agent-core/agent-loop.js 的两处
   * `runAgentLoop*` 开头）。用它会变成「抑制只对第一次完成生效」。
   */
  let aborted = createAbortEpoch((customType, data) => {
    pi.appendEntry(customType, data);
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      const handle = getTasksHandle(pi);
      captured = handle.store;
      handle.registerTaskType("async_shell", AsyncShellTask as never);
    } catch (e) {
      // 非致命：async 工具本身仍可用，只是不接 task_kill / task 面板。
      logError(e, "async session_start");
    }
    // 重新加载会话时读回「已交付」记账，避免 session/load 后重复交付。
    try {
      aborted.restoreDelivered(ctx);
    } catch (e) {
      logError(e, "async restoreDelivered");
    }
    // Process-global so a teammate kill can stop children this realm spawned —
    // the teammate's task lives in ITS OWN session's TaskStore, out of reach of
    // the leader-side store sweep. Keyed so a reload replaces, not accumulates.
    registerChildReaper("async", killAsyncTasksOwnedBy);
  });

  /** 置位中止纪元（判据只认严格等于 "aborted"，拿不准就不抑制）。 */
  pi.on("agent_end", (event) => {
    aborted.noteAgentEnd(event);
  });

  /**
   * 交付点 = 解除点：用户/平台真正发起新一轮时，先把中止纪元清掉（恢复唤醒），
   * 再一次性把被抑制的完成事实交给模型判断。
   *
   * 用 `before_agent_start`（非 streaming 的 `prompt()` 才发）而不是 `agent_start`。
   */
  pi.on("before_agent_start", () => aborted.beginUserTurn());

  pi.on("session_shutdown", async () => {
    unregisterChildReaper("async");
    // 会话结束：中止纪元与待交付列表都是本会话的派生态，不能跨会话泄到下一个。
    aborted.reset();
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
          wakeup: aborted.wakeup,
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
