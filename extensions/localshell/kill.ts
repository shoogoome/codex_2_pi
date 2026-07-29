// LocalShellTask.kill 行为:
//   - 已不存在 / 已终态 → 早返回;
//   - cancel watchdog → abort exec → flush 盘缓冲 → 翻 status='killed' / endTime → evict。
//
// kill 由 Esc/task_kill/session shutdown 发起，调用方已经知道结果；和 Claude 的
// stopTask 一样不再额外发送 task_notification，避免一份 kill 显示两次。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isTerminalTaskStatus } from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import { PANEL_GRACE_MS, updateTaskState } from "../tasks/framework.js";
import {
  evictTaskOutput,
  flushTaskOutput,
} from "../tasks/diskOutput.js";
import { logError } from "../tasks/logging.js";
import type { LocalShellTaskState } from "./localShellTask.js";

export async function killLocalShellTask(
  _pi: ExtensionAPI,
  store: TaskStore,
  taskId: string,
): Promise<void> {
  const task = store.getTask(taskId) as LocalShellTaskState | undefined;
  if (!task) return;
  if (isTerminalTaskStatus(task.status)) return;

  task.cancelStallWatchdog?.();
  try {
    task.abortController.abort();
  } catch (e) {
    logError(e, "killLocalShellTask abort");
  }
  try {
    await flushTaskOutput(taskId);
  } catch (e) {
    logError(e, "killLocalShellTask flush");
  }

  updateTaskState<LocalShellTaskState>(taskId, store, (t) =>
    t.status === "running"
      ? {
          ...t,
          status: "killed",
          endTime: Date.now(),
          notified: true,
          retain: true,
          evictAfter: Date.now() + PANEL_GRACE_MS,
        }
      : t,
  );

  void evictTaskOutput(taskId);
}
