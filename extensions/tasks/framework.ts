// Task framework — 等价 Claude `claude/utils/task/framework.ts` 的核心 API。
//
// 提供 register / update / evict / poll 四件套,与 disk output 解耦。
// 各 task type 在自己的 spawn 函数里调用 registerTask,在 result handler 里调 updateTaskState
// + notifyTaskTerminal。framework 自己不发任何模型可见消息,通知由 notifications 模块控制。

import { isTerminalTaskStatus, type TaskStateBase } from "./Task.js";
import type { TaskStore } from "./taskStore.js";
import { evictTaskOutput, getTaskOutputDelta } from "./diskOutput.js";

export const POLL_INTERVAL_MS = 1000;
export const STOPPED_DISPLAY_MS = 3_000;
/**
 * Panel grace period — 占位,本期框架不直接使用。
 *
 * Claude 这里给 LocalAgent 用:terminal 后再保留 30s panel 显示再 evict。
 * 后续 LocalAgent 期接入时通过 'retain' in task && evictAfter 接入。
 */
export const PANEL_GRACE_MS = 30_000;

type Snapshot = Record<string, TaskStateBase>;

/**
 * 应用 immutable patch 到指定 task。
 *
 * - 任务不存在时 no-op(不抛错,与 Claude 行为一致)。
 * - updater 返回原引用 → 早返回不通知 listener(保留 store.set 的早返回优化)。
 */
export function updateTaskState<T extends TaskStateBase>(
  taskId: string,
  store: TaskStore,
  updater: (task: T) => T,
): void {
  store.set((prev) => {
    const task = prev[taskId] as T | undefined;
    if (!task) return prev;
    const updated = updater(task);
    if (updated === task) return prev;
    return { ...prev, [taskId]: updated };
  });
}

/**
 * 注册新 task。
 *
 * 本期框架对 retain merge 完全无知 — 那是 LocalAgent 自己 wrapper 的关注。
 * 重复注册同 id 直接覆盖。
 */
export function registerTask(task: TaskStateBase, store: TaskStore): void {
  store.set((prev) => ({ ...prev, [task.id]: task }));
}

/**
 * 终态 task 收回 — 必须满足 status terminal && notified=true。
 *
 * 兼容未来 LocalAgent:duck-typing `'retain' in task && evictAfter > now` → 不动。
 * 当下没有 task 有 retain 字段,该分支永不触发,但保留以避免后续期改 framework。
 */
export function evictTerminalTask(taskId: string, store: TaskStore): void {
  store.set((prev) => {
    const task = prev[taskId];
    if (!task) return prev;
    if (!isTerminalTaskStatus(task.status)) return prev;
    if (!task.notified) return prev;
    if ("retain" in task) {
      const evictAfter = (task as TaskStateBase & { evictAfter?: number }).evictAfter;
      if (evictAfter !== undefined && evictAfter > Date.now()) return prev;
    }
    const next = { ...prev };
    delete next[taskId];
    return next;
  });
}

export function getRunningTasks(snapshot: Snapshot): TaskStateBase[] {
  return Object.values(snapshot).filter((t) => t.status === "running");
}

// re-export 便于其它扩展直接 import 自 framework.js
export { isTerminalTaskStatus };

// ---------- pollTasks ----------

/**
 * 周期任务:
 *   (a) 扫 terminal+notified+无 retain grace → evictTerminalTask
 *   (b) 扫 running → getTaskOutputDelta 推进 outputOffset
 *
 * **不发任何模型可见消息** — 终态通知由 notifyTaskTerminal 主动发起,与 poll 解耦。
 *
 * 返回采集到的 evict / offset 数据,主要给测试用。
 */
export async function pollTasks(store: TaskStore): Promise<{
  evictedTaskIds: string[];
  updatedTaskOffsets: Record<string, number>;
}> {
  const snapshot = store.get();
  const evictedTaskIds: string[] = [];
  const updatedTaskOffsets: Record<string, number> = {};

  for (const task of Object.values(snapshot)) {
    if (isTerminalTaskStatus(task.status) && task.notified) {
      // 同步检查 retain grace
      let canEvict = true;
      if ("retain" in task) {
        const evictAfter = (task as TaskStateBase & { evictAfter?: number }).evictAfter;
        if (evictAfter !== undefined && evictAfter > Date.now()) canEvict = false;
      }
      if (canEvict) {
        evictedTaskIds.push(task.id);
      }
      continue;
    }

    if (task.status === "running") {
      const delta = await getTaskOutputDelta(task.id, task.outputOffset);
      if (delta.content) {
        updatedTaskOffsets[task.id] = delta.newOffset;
      }
    }
  }

  // 应用 patches:offset 推进 + eviction
  if (Object.keys(updatedTaskOffsets).length > 0 || evictedTaskIds.length > 0) {
    store.set((prev) => {
      let changed = false;
      const next: Snapshot = { ...prev };
      for (const [id, off] of Object.entries(updatedTaskOffsets)) {
        const fresh = next[id];
        // Re-check status — task 可能在 await 期间转 terminal
        if (fresh?.status === "running") {
          next[id] = { ...fresh, outputOffset: off };
          changed = true;
        }
      }
      for (const id of evictedTaskIds) {
        const fresh = next[id];
        if (!fresh || !isTerminalTaskStatus(fresh.status) || !fresh.notified) continue;
        if ("retain" in fresh) {
          const evictAfter = (fresh as TaskStateBase & { evictAfter?: number }).evictAfter;
          if (evictAfter !== undefined && evictAfter > Date.now()) continue;
        }
        delete next[id];
        changed = true;
      }
      return changed ? next : prev;
    });
    // evict disk output(独立 promise,不阻塞 poll 返回)
    for (const id of evictedTaskIds) {
      void evictTaskOutput(id);
    }
  }

  return { evictedTaskIds, updatedTaskOffsets };
}

// ---------- polling 计时器 ----------

let _pollTimer: NodeJS.Timeout | undefined;

export function startTaskFrameworkPolling(
  store: TaskStore,
  intervalMs: number = POLL_INTERVAL_MS,
): void {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => {
    void pollTasks(store).catch(() => {
      // pollTasks 内部已 catch fs 错误,这里兜底防 timer 死掉。
    });
  }, intervalMs);
  _pollTimer.unref?.();
}

export function stopTaskFrameworkPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = undefined;
  }
}
