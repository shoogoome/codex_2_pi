// pi-tasks-extension entrypoint.
//
// 架构总览见 docs/superpowers/specs/2026-06-02-task-framework-design.md。
//
// 职责:
//   1. 进程内创建并设置 default TaskStore — 让其它扩展通过 `getDefaultTaskStore` 拿到。
//   2. 注册 task-notification TUI renderer — Pi UI 收到本扩展发的 sendMessage 时正确渲染。
//   3. 在 session_start hook 中:latch sessionId 到 store + 重置 outputPath latch + 启动 polling。
//   4. 在 session_shutdown hook 中:停 polling + flush all disk outputs + 重置 store。
//
// 不做(留给后续期):
//   - session reload 时从 JSONL 重建 task store(留 hydrateFromSessionEntries hook)。
//   - 任何具体 task type 的 spawn / kill 逻辑。
//   - panel UI / status pill widget。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createTaskStore,
  setDefaultTaskStore,
  type TaskStore,
} from "./taskStore.js";
import { _resetTaskOutputDirForTest } from "./outputPath.js";
import { startTaskFrameworkPolling, stopTaskFrameworkPolling } from "./framework.js";
import { _clearOutputsForTest } from "./diskOutput.js";
import { registerTaskNotificationRenderer } from "./notifications.js";
import {
  installProgressContextFilter,
  registerTaskProgressRenderer,
} from "./progress.js";
import { buildTaskKillTool } from "./tools/taskKill.js";
import { buildTaskStatusTool } from "./tools/taskStatus.js";
import { buildTaskListTool } from "./tools/taskList.js";
import {
  _resetTaskTypeRegistryForTest,
  getTaskType,
  registerTaskType,
  unregisterTaskType,
} from "./taskTypeRegistry.js";
import { attachTasksHandle, type TasksHandle } from "./handle.js";

export interface TasksExtensionDeps {
  /** 测试可注入自定义 store。生产环境留空。 */
  storeFactory?: () => TaskStore;
  /** 框架 polling 间隔。默认 1000ms,与 Claude POLL_INTERVAL_MS 对齐。 */
  pollIntervalMs?: number;
}

export default function tasksExtension(
  pi: ExtensionAPI,
  deps: TasksExtensionDeps = {},
): void {
  const store = deps.storeFactory?.() ?? createTaskStore();
  setDefaultTaskStore(store);

  // Attach handle on pi.events so cross-extension consumers (localshell,
  // localagent, teammate, dream extensions) can find this store + registry
  // even though their import of `taskStore.js` resolves to a different
  // module instance under Pi's per-extension jiti loader.
  const handle: TasksHandle = {
    store,
    registerTaskType,
    getTaskType,
    unregisterTaskType,
  };
  attachTasksHandle(pi, handle);

  registerTaskNotificationRenderer(pi);
  registerTaskProgressRenderer(pi);
  installProgressContextFilter(pi);
  installProgressContextFilter(pi);

  pi.on("session_start", (_event, ctx) => {
    // sessionManager 是 ReadonlySessionManager —— 取 sessionId 即可,不要 mutate。
    store._setSessionId(ctx.sessionManager.getSessionId());
    _resetTaskOutputDirForTest();
    startTaskFrameworkPolling(store, deps.pollIntervalMs);
    pi.registerTool(buildTaskKillTool(store));
    pi.registerTool(buildTaskStatusTool(store));
    pi.registerTool(buildTaskListTool(store));
  });

  pi.on("session_shutdown", async () => {
    stopTaskFrameworkPolling();
    // 等待所有 in-flight 写盘 settle,避免 async-ENOENT-after-teardown。
    await _clearOutputsForTest();
    store._resetForTest();
    _resetTaskTypeRegistryForTest();
  });
}

// ---------- 公共 API re-export(供其它扩展直接 import 自 'pi-tasks-extension') ----------

export type { Task, TaskType, TaskStatus, TaskStateBase } from "./Task.js";
export {
  createTaskStateBase,
  generateTaskId,
  isTerminalTaskStatus,
} from "./Task.js";

export type { TaskStore } from "./taskStore.js";
export {
  createTaskStore,
  getDefaultTaskStore,
  setDefaultTaskStore,
  _setDefaultTaskStoreForTest,
} from "./taskStore.js";

export {
  evictTerminalTask,
  getRunningTasks,
  PANEL_GRACE_MS,
  POLL_INTERVAL_MS,
  pollTasks,
  registerTask,
  startTaskFrameworkPolling,
  stopTaskFrameworkPolling,
  STOPPED_DISPLAY_MS,
  updateTaskState,
} from "./framework.js";

export {
  appendTaskOutput,
  cleanupTaskOutput,
  DiskTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  getMaxTaskOutputBytes,
  getTaskOutput,
  getTaskOutputDelta,
  getTaskOutputSize,
  initTaskOutput,
  initTaskOutputAsSymlink,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
  _clearOutputsForTest,
  _setMaxBytesForTest,
  _resetMaxBytesForTest,
} from "./diskOutput.js";

export {
  getTaskOutputDir,
  getTaskOutputPath,
  _resetTaskOutputDirForTest,
} from "./outputPath.js";

export type {
  NotifyTaskTerminalOptions,
  TaskNotificationDetails,
} from "./notifications.js";
export {
  buildTaskNotificationXml,
  markTaskNotified,
  notifyTaskTerminal,
  registerTaskNotificationRenderer,
  TASK_NOTIFICATION_CUSTOM_TYPE,
} from "./notifications.js";

export type {
  TaskProgressDetails,
  TaskProgressKind,
} from "./progress.js";
export {
  emitTaskProgress,
  installProgressContextFilter,
  registerTaskProgressRenderer,
  TASK_PROGRESS_CUSTOM_TYPE,
} from "./progress.js";

export {
  EXIT_CODE_TAG,
  escapeXml,
  OUTPUT_FILE_TAG,
  RESULT_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NAMESPACE_PREFIX,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  WORKTREE_BRANCH_TAG,
  WORKTREE_PATH_TAG,
  WORKTREE_TAG,
} from "./xmlTags.js";

export { logError } from "./logging.js";

export {
  getTaskType,
  registerTaskType,
  unregisterTaskType,
  _resetTaskTypeRegistryForTest,
} from "./taskTypeRegistry.js";

export { buildTaskKillTool } from "./tools/taskKill.js";
export { buildTaskStatusTool } from "./tools/taskStatus.js";
export { buildTaskListTool } from "./tools/taskList.js";

export {
  attachTasksHandle,
  getTasksHandle,
  type TasksHandle,
} from "./handle.js";
