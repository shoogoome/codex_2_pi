import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatInterval,
  MAX_INTERVAL_MS,
  parseLoopInput,
} from "./src/parse.js";

const STATUS_KEY = "loop";
const MAX_JOBS = 50;
const IDLE_RETRY_MS = 1000;

const USAGE = `用法: /loop [间隔] <提示词>

按固定间隔重复运行提示词或斜杠命令；未指定间隔时默认为 10m。
支持: Ns、Nm、Nh、Nd（最小 1 分钟，最大 7 天）

示例:
  /loop 5m 检查部署状态
  /loop 30m /diff
  /loop 检查部署状态 every 20m
  /loop list
  /loop cancel <job-id|all>`;

interface LoopJob {
  id: string;
  prompt: string;
  intervalMs: number;
  createdAt: number;
  nextRunAt: number;
  runs: number;
  timer?: ReturnType<typeof setTimeout>;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}

function shortPrompt(prompt: string, max = 52): string {
  return prompt.length <= max ? prompt : `${prompt.slice(0, max - 1)}…`;
}

export default function loopExtension(pi: ExtensionAPI): void {
  const jobs = new Map<string, LoopJob>();
  let latestCtx: ExtensionContext | undefined;

  function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // UI may have been replaced with the session.
    }
  }

  function updateStatus(ctx = latestCtx): void {
    if (!ctx?.hasUI) return;
    try {
      if (jobs.size === 0) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const next = [...jobs.values()].sort((a, b) => a.nextRunAt - b.nextRunAt)[0]!;
      const remainingMs = Math.max(0, next.nextRunAt - Date.now());
      const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
      ctx.ui.setStatus(STATUS_KEY, `Loop: ${jobs.size} · next ${remainingMinutes}m`);
    } catch {
      // UI may have been replaced with the session.
    }
  }

  function clearJob(job: LoopJob): void {
    if (job.timer !== undefined) clearTimeout(job.timer);
    job.timer = undefined;
    jobs.delete(job.id);
  }

  function clearAll(): void {
    for (const job of jobs.values()) {
      if (job.timer !== undefined) clearTimeout(job.timer);
    }
    jobs.clear();
    updateStatus();
  }

  function arm(job: LoopJob, delayMs = Math.max(0, job.nextRunAt - Date.now())): void {
    if (!jobs.has(job.id)) return;
    if (job.timer !== undefined) clearTimeout(job.timer);
    job.timer = setTimeout(() => fire(job.id), delayMs);
    unrefTimer(job.timer);
  }

  function fire(id: string): void {
    const job = jobs.get(id);
    if (!job) return;
    job.timer = undefined;

    if (Date.now() - job.createdAt >= MAX_INTERVAL_MS) {
      clearJob(job);
      updateStatus();
      return;
    }

    const ctx = latestCtx;
    if (!ctx) {
      arm(job, IDLE_RETRY_MS);
      return;
    }

    try {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        arm(job, IDLE_RETRY_MS);
        return;
      }
      pi.sendUserMessage(job.prompt);
    } catch {
      arm(job, IDLE_RETRY_MS);
      return;
    }

    job.runs += 1;
    job.nextRunAt = Date.now() + job.intervalMs;
    arm(job);
    updateStatus(ctx);
  }

  function listJobs(ctx: ExtensionContext): void {
    if (jobs.size === 0) {
      notify(ctx, "当前没有循环任务。", "info");
      return;
    }
    const lines = [...jobs.values()]
      .sort((a, b) => a.nextRunAt - b.nextRunAt)
      .map((job) => `${job.id} · every ${formatInterval(job.intervalMs)} · ${shortPrompt(job.prompt)}`);
    notify(ctx, `循环任务 (${jobs.size}/${MAX_JOBS}):\n${lines.join("\n")}`, "info");
  }

  function cancelJobs(target: string, ctx: ExtensionContext): void {
    if (!target) {
      notify(ctx, "用法: /loop cancel <job-id|all>", "warning");
      return;
    }
    if (target === "all") {
      const count = jobs.size;
      clearAll();
      notify(ctx, count === 0 ? "当前没有循环任务。" : `已取消 ${count} 个循环任务。`, "info");
      return;
    }
    const job = jobs.get(target);
    if (!job) {
      notify(ctx, `未找到循环任务: ${target}`, "warning");
      return;
    }
    clearJob(job);
    updateStatus(ctx);
    notify(ctx, `已取消循环任务 ${target}。`, "info");
  }

  pi.registerCommand("loop", {
    description: "按固定间隔重复运行提示词或斜杠命令: /loop [interval] <prompt>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      latestCtx = ctx;
      const trimmed = args.trim();
      if (!trimmed || trimmed === "help") {
        notify(ctx, USAGE, "info");
        return;
      }
      if (trimmed === "list" || trimmed === "status") {
        listJobs(ctx);
        return;
      }
      const management = /^(?:cancel|stop|delete)\s*(.*)$/i.exec(trimmed);
      if (management) {
        cancelJobs(management[1]!.trim(), ctx);
        return;
      }
      if (jobs.size >= MAX_JOBS) {
        notify(ctx, `循环任务已达上限 (${MAX_JOBS})，请先取消一个。`, "warning");
        return;
      }

      const parsed = parseLoopInput(trimmed);
      if (!parsed.ok) {
        notify(ctx, `${parsed.error}\n\n${USAGE}`, "warning");
        return;
      }

      const now = Date.now();
      const job: LoopJob = {
        id: `loop-${randomUUID().slice(0, 8)}`,
        prompt: parsed.value.prompt,
        intervalMs: parsed.value.intervalMs,
        createdAt: now,
        nextRunAt: now + parsed.value.intervalMs,
        runs: 0,
      };
      jobs.set(job.id, job);
      arm(job);
      updateStatus(ctx);

      const rounding = parsed.value.roundedFrom
        ? `（${parsed.value.roundedFrom} 已按分钟粒度取整为 ${parsed.value.intervalLabel}）`
        : "";
      notify(
        ctx,
        `已创建 ${job.id}: every ${parsed.value.intervalLabel}${rounding}。任务仅在当前会话有效，7 天后自动过期；正在立即执行一次。`,
        "info",
      );

      try {
        if (ctx.isIdle()) pi.sendUserMessage(job.prompt);
        else pi.sendUserMessage(job.prompt, { deliverAs: "followUp" });
      } catch {
        clearJob(job);
        updateStatus(ctx);
        notify(ctx, `无法执行 ${job.id}，循环任务已取消。`, "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearAll();
    latestCtx = ctx;
  });
  pi.on("session_shutdown", async () => {
    clearAll();
    latestCtx = undefined;
  });
}
