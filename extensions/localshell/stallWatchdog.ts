// Stall watchdog — 监测任务输出长时间停滞 + 像交互式 prompt 时,
// 推一条 'tasks/notification' 进度消息(extra.kind='stall-prompt'),
// 不带 <status> tag(避免被消费方误判为终态)。
//
// 行为对齐 claude/tasks/LocalShellTask/LocalShellTask.tsx:startStallWatchdog
// (5s 周期 / 45s 阈值 / 1024 bytes tail / 命中 latch 后不重发)。
//
// 注意:内部使用同步 I/O(statSync/openSync/readSync),避免 fake timer 测试中
// 异步 I/O 与 setInterval 时序问题 — 对 background watchdog 可接受。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { TASK_NOTIFICATION_CUSTOM_TYPE, escapeXml } from "../tasks/index.js";

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

function tailFileSync(path: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const s = statSync(path);
    const start = Math.max(0, s.size - bytes);
    const len = s.size - start;
    if (len === 0) return "";
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    if (fd !== undefined) closeSync(fd);
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
    try {
      const s = statSync(outputFile);
      if (s.size > lastSize) {
        lastSize = s.size;
        lastGrowth = Date.now();
        return;
      }
      if (Date.now() - lastGrowth < STALL_THRESHOLD_MS) return;
      let tail = "";
      try {
        tail = tailFileSync(outputFile, STALL_TAIL_BYTES);
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
      // display:true + triggerTurn:false — 立即渲染 TUI 并进入 LLM 上下文
      // (streaming 中 steer 进当前 turn;空闲时挂到 state,下轮自然被看到)。
      // 不用 deliverAs:"nextTurn":那会把消息塞进 pending 队列等用户下次输入,
      // 可能几小时后才冒出来,内容早已过期(“化石通知”)。
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
            summary: `Background command "${description}" appears to be waiting for interactive input`,
            outputFile,
            timestamp: Date.now(),
            extra: { kind: "stall-prompt" },
          },
        } as never,
        { triggerTurn: false },
      );
    } catch {
      // statSync 失败(file not yet exists 等) → 跳过此 tick
    }
  }, STALL_CHECK_INTERVAL_MS);
  timer.unref?.();

  return () => {
    cancelled = true;
    clearInterval(timer);
  };
}

