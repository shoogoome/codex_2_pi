// Task framework — 等价 Claude `claude/utils/task/framework.ts` 的核心 API。
//
// 提供 register / update / evict / poll 四件套,与 disk output 解耦。
// 各 task type 在自己的 spawn 函数里调用 registerTask,在 result handler 里调 updateTaskState
// + notifyTaskTerminal。framework 自己不发任何模型可见消息,通知由 notifications 模块控制。

import { isTerminalTaskStatus, type TaskStateBase } from "./Task.js";
import type { TaskStore } from "./taskStore.js";
import { evictTaskOutput, getTaskOutputTailDelta } from "./diskOutput.js";

export const POLL_INTERVAL_MS = 1000;
export const STOPPED_DISPLAY_MS = 3_000;
/**
 * 单个 running 任务、单轮 poll 的输出读取上限(仅面板可见时)。
 *
 * 面板可见时,pollTasks 用 tail-biased 读取(`getTaskOutputTailDelta`)驱动
 * 面板/overlay 刷新。封顶到 256KB 确保即便任务是每秒吐几 MB 的 firehose
 * (pxdev dev server / Puppeteer),单轮读取也恒定 ≤256KB(偏向最近输出),
 * 不会随文件增长而放大 CPU/内存。
 */
export const POLL_MAX_READ_BYTES = 256 * 1024;
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
 * pollTasks 的可选项 — 控制"是否读输出内容"与"单轮读取上限"。
 *
 * 关键:`isPanelVisible` 是 CPU 空转 bug 的核心门控。
 */
export interface PollTasksOptions {
  /**
   * 后台任务面板/overlay 当前是否可见(即输出内容是否真的显示在屏幕上)。
   *
   * - 返回 false(默认,未传时视为 false):对 running 任务**完全不读输出内容**
   *   —— 不调 `getTaskOutputTailDelta`。idle pi(没在看面板)因此对 running 任务
   *   零输出读取,即便有 firehose 任务在每秒吐几 MB,CPU 也保持 ~0。
   * - 返回 true:才按 tail-biased 方式读增量(封顶 `maxReadBytes`)驱动面板刷新。
   *
   * 注意:终态检测 / eviction / 终态通知(notifyTaskTerminal)都不依赖这个读取,
   * 所以门控关闭时它们照常工作。
   */
  isPanelVisible?: () => boolean;
  /** 面板可见时单任务单轮读取上限。默认 {@link POLL_MAX_READ_BYTES}(256KB)。 */
  maxReadBytes?: number;
}

/**
 * 周期任务:
 *   (a) 扫 terminal+notified+无 retain grace → evictTerminalTask
 *   (b) 扫 running → **仅面板可见时** getTaskOutputTailDelta 推进 outputOffset
 *
 * **不发任何模型可见消息** — 终态通知由 notifyTaskTerminal 主动发起,与 poll 解耦。
 *
 * 面板不可见时:running 任务分支完全跳过输出读取(见 PollTasksOptions.isPanelVisible),
 * offset 保持不动 —— 面板下次打开时 `getTaskOutputTailDelta` 会从 tail 补读一段
 * (跳过已积压的中间字节,只读最近 maxReadBytes),因此不会因 offset 陈旧而爆读。
 *
 * 返回采集到的 evict / offset 数据,主要给测试用。
 */
export async function pollTasks(
  store: TaskStore,
  options: PollTasksOptions = {},
): Promise<{
  evictedTaskIds: string[];
  updatedTaskOffsets: Record<string, number>;
}> {
  const panelVisible = options.isPanelVisible?.() === true;
  const maxReadBytes = options.maxReadBytes ?? POLL_MAX_READ_BYTES;
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
      // 面板可见性门控 —— 面板/overlay 没在显示输出时,对 running 任务零输出读取。
      // 这是修复 idle pi 空转的关键:firehose 任务(pxdev / Puppeteer)每秒吐几 MB,
      // 但只要用户没在看输出,就不读、不解码、不重绘。终态/eviction/通知不受影响。
      if (!panelVisible) continue;
      const delta = await getTaskOutputTailDelta(task.id, task.outputOffset, maxReadBytes);
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
/**
 * 防重入守卫:上一轮 pollTasks 尚未 settle 时,跳过本轮 timer 触发。
 *
 * 面板可见 + firehose 任务时,单轮读取虽已封顶 256KB,但若磁盘慢导致某轮
 * >1s,不加守卫会让多轮 pollTasks 叠加并发,进一步放大 CPU/句柄占用。守卫保证
 * 任意时刻至多一轮在飞。
 */
let _pollInFlight = false;

export function startTaskFrameworkPolling(
  store: TaskStore,
  intervalMs: number = POLL_INTERVAL_MS,
  options: PollTasksOptions = {},
): void {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => {
    if (_pollInFlight) return; // 上一轮未完成 → 跳过本轮,不叠加
    _pollInFlight = true;
    void pollTasks(store, options)
      .catch(() => {
        // pollTasks 内部已 catch fs 错误,这里兜底防 timer 死掉。
      })
      .finally(() => {
        _pollInFlight = false;
      });
  }, intervalMs);
  _pollTimer.unref?.();
}

export function stopTaskFrameworkPolling(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = undefined;
  }
  _pollInFlight = false;
}
