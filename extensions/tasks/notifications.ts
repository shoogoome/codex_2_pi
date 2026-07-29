// Terminal task 通知 — 把 task 终态广播到 Pi 的所有可见通道(LLM / TUI / RPC / JSON / session)。
//
// 设计要点:
//   - notified 是原子 CAS — 通过 `markTaskNotified` 在 store.set 内部 read-then-write。
//     防止 TaskStopTool 与各 task type 自身 result handler 双发通知(等价 Claude markTaskNotified)。
//   - 复用 Pi 的 `pi.sendMessage` 单一入口 — 它会自动路由到:
//       (a) RPC mode → stdout JSONL message_start/message_end 事件
//       (b) JSON mode → 同上
//       (c) TUI mode → registerMessageRenderer 注册的渲染器
//       (d) session_format → JSONL `type:"custom_message"` 持久化(reload 后还能 reload)
//       (e) LLM context → display=true 且 deliverAs/triggerTurn 控制是否抢 turn
//   - content 是 XML 字符串 — LLM 训练数据里见过 Claude 的 schema,直接懂。
//   - details 是结构化 JSON — RPC 客户端 / TUI renderer 用,不依赖文本解析。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { TaskStateBase, TaskType } from "./Task.js";
import type { TaskStore } from "./taskStore.js";
import { installCustomTypeContextFilter } from "./contextFilter.js";
import { PANEL_GRACE_MS } from "./framework.js";
import {
  EXIT_CODE_TAG,
  escapeXml,
  OUTPUT_FILE_TAG,
  RESULT_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_CUSTOM_TYPE,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  WORKTREE_BRANCH_TAG,
  WORKTREE_PATH_TAG,
  WORKTREE_TAG,
} from "./xmlTags.js";

export { TASK_NOTIFICATION_CUSTOM_TYPE };

/**
 * RPC 客户端 / TUI renderer 用的结构化 details。
 *
 * 各具体 task type 在 `extra` 里塞自己的字段(LocalAgent 加 progress、Teammate 加 identity 等)。
 */
export interface TaskNotificationDetails {
  taskId: string;
  taskType: TaskType;
  status: "running" | "completed" | "failed" | "killed";
  description: string;
  /** Human-facing one-line summary; mirrors Claude's <summary> payload. */
  summary?: string;
  outputFile: string;
  toolUseId?: string;
  exitCode?: number;
  finalMessage?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  durationMs?: number;
  timestamp: number;
  extra?: Record<string, unknown>;
}

export interface NotifyTaskTerminalOptions {
  taskId: string;
  taskType: TaskType;
  status: "completed" | "failed" | "killed";
  description: string;
  outputFile: string;
  toolUseId?: string;
  exitCode?: number;
  finalMessage?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  durationMs?: number;
  /** 终态 task 在内存中保留多久，供 task_status/task_list 查询。默认 30s。 */
  retainMs?: number;
  /** 自定义文案,覆盖默认 status 模板。 */
  summary?: string;
  /**
   * 是否触发主 agent 立即跑下一轮 turn。
   * 不传(undefined) — 把消息立即渲染到会话流但不抢 turn(适合 LLM mid-turn 等待工具结果的场景)。
   * 后台 task 完成时传 `true` — 主动唤醒 LLM。
   */
  triggerTurn?: boolean;
  /**
   * 是否在 TUI 主流渲染一行终态。
   * 不传(undefined)时默认 `triggerTurn === true`(后台唤醒才画行,同步路径抑制,
   * 避免与工具自身 renderResult 重复)。显式传入可解耦两者 — 例如后台终态
   * 不抢 turn(triggerTurn:false)但仍在 TUI 画一行(display:true)。
   */
  display?: boolean;
  /**
   * 是否让该通知进入 LLM context。默认 true。
   * 传 false 时消息照常发(TUI/RPC/JSONL 保留),但 tasks/index.ts 安装的
   * notification context 过滤器会把它从 provider payload 剥离。
   * 用于只需要 TUI/RPC/JSONL 留痕、不应打断或污染模型上下文的通知
   * （例如默认非唤醒模式下的后台 local_bash 终态）。
   */
  llmVisible?: boolean;
  /**
   * 投递语义 — **通常不要传**。
   * 不传(undefined)时立即渲染(推荐)。
   * ⚠️ 传 `"nextTurn"` 会让 Pi agent-session 把消息放进 pending 队列等用户输入,
   *    即使同时传了 triggerTurn:true 也无效 — 这是 deliverAs 优先于 triggerTurn 的陷阱。
   */
  deliverAs?: "steer" | "followUp" | "nextTurn";
  /** 给 details.extra 塞自定义结构。 */
  extra?: Record<string, unknown>;
}

/**
 * 原子 CAS:把 task.notified 从 false 翻到 true。
 *
 * - 调用方应只有"翻转成功(返回 true)"才发通知。
 * - 任务不存在或已 notified 时返回 false(调用方应静默跳过)。
 *
 * 等价 Claude `claude/tasks/RemoteAgentTask/RemoteAgentTask.tsx:markTaskNotified`,
 * 但本期不限定 task type — 任何 TaskStateBase 都可被 mark。
 */
export function markTaskNotified(
  taskId: string,
  store: TaskStore,
  retainMs: number = PANEL_GRACE_MS,
): boolean {
  let flipped = false;
  store.set((prev) => {
    const task = prev[taskId];
    if (!task || task.notified) return prev;
    flipped = true;
    return {
      ...prev,
      [taskId]: {
        ...task,
        notified: true,
        // Grace period — let callers inspect the task via task_status/task_list
        // after notification. Framework's existing retain + evictAfter
        // duck-typing defers eviction; callers may override the default 30s.
        retain: true,
        evictAfter: Date.now() + Math.max(0, retainMs),
      } as TaskStateBase,
    };
  });
  return flipped;
}

const STATUS_TEXT: Record<NotifyTaskTerminalOptions["status"], string> = {
  completed: "completed successfully",
  failed: "failed",
  killed: "was stopped",
};

function statusText(status: NotifyTaskTerminalOptions["status"]): string {
  return STATUS_TEXT[status];
}

/** 拼 task-notification XML — LLM 友好的 schema(对齐 Claude)。 */
export function buildTaskNotificationXml(opts: NotifyTaskTerminalOptions): string {
  const lines: string[] = [];
  lines.push(`<${TASK_NOTIFICATION_TAG}>`);
  lines.push(`<${TASK_ID_TAG}>${escapeXml(opts.taskId)}</${TASK_ID_TAG}>`);
  if (opts.toolUseId) {
    lines.push(`<${TOOL_USE_ID_TAG}>${escapeXml(opts.toolUseId)}</${TOOL_USE_ID_TAG}>`);
  }
  lines.push(`<${TASK_TYPE_TAG}>${opts.taskType}</${TASK_TYPE_TAG}>`);
  lines.push(`<${OUTPUT_FILE_TAG}>${escapeXml(opts.outputFile)}</${OUTPUT_FILE_TAG}>`);
  lines.push(`<${STATUS_TAG}>${opts.status}</${STATUS_TAG}>`);
  const summary = opts.summary ?? `${opts.description} ${statusText(opts.status)}`;
  lines.push(`<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>`);
  if (opts.exitCode !== undefined) {
    lines.push(`<${EXIT_CODE_TAG}>${opts.exitCode}</${EXIT_CODE_TAG}>`);
  }
  if (opts.finalMessage) {
    lines.push(`<${RESULT_TAG}>${escapeXml(opts.finalMessage)}</${RESULT_TAG}>`);
  }
  if (opts.worktreePath) {
    lines.push(
      `<${WORKTREE_TAG}>` +
        `<${WORKTREE_PATH_TAG}>${escapeXml(opts.worktreePath)}</${WORKTREE_PATH_TAG}>` +
        (opts.worktreeBranch
          ? `<${WORKTREE_BRANCH_TAG}>${escapeXml(opts.worktreeBranch)}</${WORKTREE_BRANCH_TAG}>`
          : "") +
        `</${WORKTREE_TAG}>`,
    );
  }
  lines.push(`</${TASK_NOTIFICATION_TAG}>`);
  return lines.join("\n");
}

/**
 * Pi sendMessage 选项构建器。
 *
 * **关键约束**:Pi agent-session.js:967 先检查 deliverAs === "nextTurn",
 * 如果成立就把消息放进 pending 队列等用户下次输入 — triggerTurn 被完全忽略。
 * 因此:
 *   - 只要调用方没有**显式**传入 deliverAs,就不设置该字段(留 undefined)。
 *   - undefined deliverAs 时:triggerTurn=false → 立即渲染但不开 turn;
 *                            triggerTurn=true  → agent.prompt(...) 唤醒 LLM。
 */
function buildSendMessageOptions(opts: NotifyTaskTerminalOptions): {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
} {
  const out: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } = {};
  if (opts.triggerTurn !== undefined) out.triggerTurn = opts.triggerTurn;
  if (opts.deliverAs !== undefined) out.deliverAs = opts.deliverAs;
  return out;
}

/**
 * 把 task 终态广播出去 — CAS + sendMessage。
 *
 * **重复调用静默跳过**(CAS)— 多个异步完成/停止路径并发抵达时只会发一次。
 *
 * 默认行为(opts.triggerTurn / opts.deliverAs 都不传):立即渲染、不主动开 turn。
 * 后台 task 完成时调用方应传 `triggerTurn: true` 主动唤醒 LLM。**不要传**
 * `deliverAs: "nextTurn"` — Pi agent-session 会把它放进 pending 队列等用户输入,
 * triggerTurn 失效。
 */
export function notifyTaskTerminal(
  pi: ExtensionAPI,
  store: TaskStore,
  opts: NotifyTaskTerminalOptions,
): void {
  if (!markTaskNotified(opts.taskId, store, opts.retainMs)) return;
  const content = buildTaskNotificationXml(opts);
  const llmVisible = opts.llmVisible !== false;
  const details: TaskNotificationDetails = {
    taskId: opts.taskId,
    taskType: opts.taskType,
    status: opts.status,
    description: opts.description,
    summary: opts.summary ?? `${opts.description} ${statusText(opts.status)}`,
    outputFile: opts.outputFile,
    toolUseId: opts.toolUseId,
    exitCode: opts.exitCode,
    finalMessage: opts.finalMessage,
    worktreePath: opts.worktreePath,
    worktreeBranch: opts.worktreeBranch,
    durationMs: opts.durationMs,
    timestamp: Date.now(),
    // llmVisible:false 时打标记 — installTaskNotificationContextFilter 据此
    // 把本条从 LLM payload 剥离(TUI/RPC/JSONL 不受影响)。
    extra: llmVisible ? opts.extra : { ...opts.extra, llmVisible: false },
  };
  pi.sendMessage<TaskNotificationDetails>(
    {
      customType: TASK_NOTIFICATION_CUSTOM_TYPE,
      content,
      // Async wakeups (background task completes while the user is
      // doing something else) paint a row to the TUI so the completion
      // is visible. Sync paths suppress by default: the originating
      // tool's own renderResult already surfaces the terminal line in
      // the same conversation slot, and a second customMessage row was
      // the visible "三块 task_agent 信息" duplication the user reported.
      // 显式 opts.display 可解耦 display 与 triggerTurn(例如后台终态
      // 不抢 turn 但仍画一行)。Note: display:false only hides the TUI
      // surface — the RPC stream and JSONL persistence still receive
      // the full XML payload via Pi's sendMessage routing; LLM context
      // 由 llmVisible 选项 + context 过滤器控制。
      display: opts.display ?? opts.triggerTurn === true,
      details,
    },
    buildSendMessageOptions(opts),
  );
}

/**
 * 剥离 llmVisible:false 的 tasks/notification。这类通知仍给 TUI/RPC/JSONL
 * 留痕，但不进入 LLM 上下文；显式唤醒的后台终态、stall-prompt、agent 结果等
 * llmVisible 通知不受影响。
 */
export function installTaskNotificationContextFilter(
  pi: Pick<ExtensionAPI, "on">,
): void {
  installCustomTypeContextFilter(pi, TASK_NOTIFICATION_CUSTOM_TYPE, (msg) => {
    const d = msg.details as TaskNotificationDetails | undefined;
    return d?.extra?.llmVisible === false;
  });
}

// ---------- TUI Renderer ----------

const STATUS_COLOR: Record<TaskNotificationDetails["status"], ThemeColor> = {
  running: "warning",
  completed: "success",
  failed: "error",
  killed: "warning",
};

/**
 * 注册 task-notification 的 TUI 渲染器。
 *
 * - 折叠:对齐 Claude UserAgentNotificationMessage：状态色 `●` + 默认色 summary。
 * - 展开:多行 — summary / task_id+type+status / output / 完整 XML。
 *
 * 风格对齐 pi-tui Text + Box + theme.fg/bg pattern。
 */
export function registerTaskNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<TaskNotificationDetails>(
    TASK_NOTIFICATION_CUSTOM_TYPE,
    (message, { expanded }, theme): Component | undefined => {
      const details = message.details;
      if (!details) {
        const text = typeof message.content === "string" ? message.content : "";
        return new Text(theme.fg("toolOutput", text), 0, 0);
      }
      const colorKey = STATUS_COLOR[details.status];
      const summary =
        details.summary ??
        (details.status === "running"
          ? details.description
          : `${details.description} ${statusText(details.status)}` +
            (details.exitCode !== undefined ? ` (exit ${details.exitCode})` : ""));
      // Claude UserAgentNotificationMessage: a status-colored black circle,
      // followed by summary text in the normal foreground color.
      const headline = `${theme.fg(colorKey, "●")} ${theme.fg("text", summary)}`;

      if (!expanded) {
        return new Text(headline, 0, 0);
      }

      const box = new Box(1, 1, (value: string) => theme.bg("customMessageBg", value));
      box.addChild(
        new Text(
          `${theme.fg(colorKey, "●")} ${theme.bold(theme.fg("text", summary))}`,
          0,
          0,
        ),
      );
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            `task_id: ${details.taskId}  type: ${details.taskType}  status: ${details.status}`,
          ),
          0,
          0,
        ),
      );
      box.addChild(new Text(theme.fg("dim", `output: ${details.outputFile}`), 0, 0));
      if (details.worktreePath) {
        box.addChild(
          new Text(
            theme.fg(
              "dim",
              `worktree: ${details.worktreePath}` +
                (details.worktreeBranch ? ` (${details.worktreeBranch})` : ""),
            ),
            0,
            0,
          ),
        );
      }
      if (details.finalMessage) {
        box.addChild(new Text(theme.fg("toolOutput", details.finalMessage), 0, 0));
      }
      const content = typeof message.content === "string" ? message.content : "";
      for (const line of content.split("\n")) {
        if (line) box.addChild(new Text(theme.fg("dim", line), 0, 0));
      }
      return box;
    },
  );
}
