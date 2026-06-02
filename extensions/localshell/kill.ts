// LocalShellTask.kill 行为:
//   - 已不存在 / 已终态 → 早返回;
//   - cancel watchdog → abort exec → flush 盘缓冲 → 翻 status='killed' / endTime → notifyTaskTerminal(CAS) → evict。
//
// notifyTaskTerminal 自带 CAS,所以二次 kill 不会双发通知(测试覆盖)。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isTerminalTaskStatus } from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import { updateTaskState } from "../tasks/framework.js";
import {
  evictTaskOutput,
  flushTaskOutput,
} from "../tasks/diskOutput.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { logError } from "../tasks/logging.js";
import type { LocalShellTaskState } from "./localShellTask.js";

export async function killLocalShellTask(
  pi: ExtensionAPI,
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
      ? { ...t, status: "killed", endTime: Date.now() }
      : t,
  );

  notifyTaskTerminal(pi, store, {
    taskId,
    taskType: "local_bash",
    status: "killed",
    description: task.description,
    outputFile: task.outputFile,
    toolUseId: task.toolUseId,
  });

  void evictTaskOutput(taskId);
}
