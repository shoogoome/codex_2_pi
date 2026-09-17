// interruptTeammate — 打断一个成员"当前正在执行的东西"，但不杀它。
//
// ## 为什么需要它（与 task_kill 的区别）
//
// 三种手段，语义完全不同：
//
//   send_message              投递消息，**排队**等当前工具调用返回才被读到。
//                             成员在长命令里时，这条消息等于没发。
//   interruptTeammate（本文件）中止**当前回合**（session.abort），把纠正指令作为
//                             下一轮 prompt 立刻投递。成员**活着并继续工作**。
//   task_kill                 终止成员本身（abortController + dispose）。
//
// 缺了中间这一档，leader 只有两个极端：要么只能排队等（慢），要么只能杀掉重派
// （贵，且丢失成员已有的上下文与成果）。真实的教训是后者：一个成员卡在 200 秒
// 轮询里读不到消息，leader 只能把它开除，而它其实正常。
//
// ## 为什么不复用 killTeammate
//
// kill 会 `abortController.abort()` —— 那会终结 teammateLoop 的整个等待循环，
// 成员就此消失。打断要的恰恰相反：只掐掉**当前这一次 prompt**，循环要留着，
// 好让后续消息继续被处理。所以这里**只调 session.abort()**。
//
// ## session.abort() 的语义（pi 0.85.0）
//
//   async abort() { abortRetry(); abortCompaction(); abortBranchSummary();
//                   this.agent.abort(); await this.waitForIdle(); }
//
// 它停掉进行中的 LLM 调用与工具执行，等会话回到 idle，然后返回。会话**没有被
// dispose**，可以继续 prompt —— 这正是"打断后还能接着干活"的基础。
//
// abort 会让当前 prompt 以 `stopReason: "aborted"` 结束。teammateLoop 的
// promptWithErrorDetection 只把 `stopReason === "error"` 当失败，aborted 不算，
// 所以循环不会误判成 turn 失败；但它也不会自动重试 —— 正好由我们补上那一轮。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../tasks/taskStore.js";
import { isTerminalTaskStatus } from "../tasks/Task.js";
import { updateTaskState } from "../tasks/framework.js";
import { logError } from "../tasks/logging.js";
import { emitTeammateEvent } from "./eventEmit.js";
import { markInterruptRequested } from "./teammateLoop.js";
import type { TeammateHandle } from "./handle.js";
import type { InProcessTeammateTaskState } from "./types.js";
import { isInProcessTeammateTask } from "./types.js";

export interface InterruptResult {
  ok: boolean;
  /** 为什么没打断（ok=false 时）。 */
  reason?: "not_found" | "terminal" | "no_session";
  /** 打断时它是否正在干活（false = 本来就空闲）。 */
  wasBusy?: boolean;
  /** 打断前它正卡在哪个工具里（若有记录）。 */
  wasInTool?: string;
  /** 被打断的回合已经跑了多久。 */
  busyForMs?: number;
  agentId?: string;
}

/** 在 taskStore 里按 agentId 找一个存活的成员任务。 */
export function findTeammateTask(
  taskStore: TaskStore,
  agentId: string,
): InProcessTeammateTaskState | undefined {
  for (const t of Object.values(taskStore.get())) {
    if (
      isInProcessTeammateTask(t) &&
      t.identity.agentId === agentId
    ) {
      return t;
    }
  }
  return undefined;
}

/**
 * 打断成员当前执行，立即返回。
 *
 * 调用方随后应把纠正指令作为消息投递给它（mailbox.send）。顺序很关键：
 * **先 abort，再投递**。反过来的话消息会被循环拿去当一轮 prompt，而那一轮正
 * 撞在被中止的旧回合上，纠正指令就可能被丢掉或与旧上下文打架。
 *
 * abort 之后不要立即断言成员已在等待队列 —— `session.abort()` 内部会
 * `await waitForIdle()`，resolve 时就已 idle，投递进去的消息会被循环立刻取走。
 */
export async function interruptTeammate(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  handle: TeammateHandle,
  agentId: string,
): Promise<InterruptResult> {
  const task = findTeammateTask(taskStore, agentId);
  if (!task) return { ok: false, reason: "not_found" };
  if (isTerminalTaskStatus(task.status)) return { ok: false, reason: "terminal" };
  const session = task.session;
  if (!session) return { ok: false, reason: "no_session" };

  const wasBusy = !task.isIdle;
  const wasInTool = task.lastTool;
  const busyForMs =
    task.lastToolStartedAt !== undefined
      ? Date.now() - task.lastToolStartedAt
      : undefined;

  // Tell the loop WHY its prompt is about to be cancelled, before it is.
  // Without this the aborted turn is indistinguishable from a real failure and
  // the leader gets a misleading "[teammate X turn failed]" notification on the
  // very turn we just cancelled — observed for real, and it made the leader
  // re-verify an interrupt that had already worked.
  markInterruptRequested(agentId);
  try {
    await session.abort();
  } catch (e) {
    // Aborting an already-idle session is a no-op, not a failure. Anything
    // else must be surfaced rather than silently swallowed — the caller is
    // about to claim it interrupted the teammate.
    logError(e, "interruptTeammate session.abort");
    return { ok: false, reason: "no_session", wasBusy, wasInTool, busyForMs, agentId };
  }

  // 让 task_status 的诊断行反映"刚被打断"这件事，leader 后续排查时能看见。
  try {
    updateTaskState<InProcessTeammateTaskState>(
      task.id,
      taskStore,
      (t) => ({ ...t, isIdle: true }),
    );
  } catch (e) {
    logError(e, "interruptTeammate mark idle");
  }

  emitTeammateEvent(pi, {
    kind: "teammate_interrupted",
    agentId,
    wasBusy,
    ...(wasInTool !== undefined ? { inTool: wasInTool } : {}),
    ...(busyForMs !== undefined ? { busyForMs } : {}),
  });

  return { ok: true, wasBusy, wasInTool, busyForMs, agentId };
}

/** 人类可读的"打断了什么"。用于工具返回文本，让 leader 知道止损是否生效。 */
export function describeInterrupt(result: InterruptResult, agentId: string): string {
  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        return `No live teammate '${agentId}' in this session. Check the roster with team_roster().`;
      case "terminal":
        return `Teammate '${agentId}' has already terminated; nothing to interrupt.`;
      case "no_session":
        return `Teammate '${agentId}' has no live session to interrupt (it may be mid-respawn).`;
    }
  }
  if (!result.wasBusy) {
    return (
      `'${agentId}' was already idle — nothing was running. ` +
      `Your message is queued and will start its next turn.`
    );
  }
  const inTool = result.wasInTool ? ` inside \`${result.wasInTool}\`` : "";
  const held =
    result.busyForMs !== undefined ? ` for ${formatMs(result.busyForMs)}` : "";
  return (
    `Interrupted '${agentId}' — it was running${inTool}${held}. ` +
    `That work was stopped; the teammate is still alive and will now process your message.`
  );
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m}m` : `${m}m${rest}s`;
}
