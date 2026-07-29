// pi-tasks-extension entrypoint.
//
// 架构总览见 docs/superpowers/specs/2026-06-02-task-framework-design.md。
//
// 职责:
//   1. 进程内创建并设置 default TaskStore — 让其它扩展通过 `getDefaultTaskStore` 拿到。
//   2. 注册 task-notification TUI renderer — Pi UI 收到本扩展发的 sendMessage 时正确渲染。
//   3. 在 session_start hook 中:latch sessionId 到 store + 重置 outputPath latch + 启动 polling。
//   4. session_start hasUI=true 时:挂背景 agents panel widget(对齐 claudecode 的
//      "Waiting for N background agents to finish")+ Ctrl+Y 焦点切换 + Enter 进
//      task output overlay。Esc 退出 overlay。仅显示 local_agent 任务。
//   5. 在 session_shutdown hook 中:停 polling + flush all disk outputs + 重置 store。

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import {
  createTaskStore,
  setDefaultTaskStore,
  type TaskStore,
} from "./taskStore.js";
import { _resetTaskOutputDirForTest } from "./outputPath.js";
import { startTaskFrameworkPolling, stopTaskFrameworkPolling } from "./framework.js";
import { _clearOutputsForTest } from "./diskOutput.js";
import {
  installTaskNotificationContextFilter,
  registerTaskNotificationRenderer,
} from "./notifications.js";
import {
  installProgressContextFilter,
  registerTaskProgressRenderer,
} from "./progress.js";
import {
  installTaskSummaryContextFilter,
  registerTaskSummaryRenderer,
} from "./summary.js";
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
import { logError } from "./logging.js";
import { buildTaskPanel } from "./ui/taskPanel.js";
import { createTaskPanelViewStateStore } from "./ui/viewState.js";
import { registerTaskPanelKeybindings } from "./ui/taskPanelKeybindings.js";
import { buildTaskOutputOverlayComponent } from "./ui/taskOutputOverlayComponent.js";
import type { TaskPanelEntry } from "./ui/taskPanelRender.js";
import type { TaskOutputOverlayTheme } from "./ui/taskOutputOverlayRender.js";
import type { LocalAgentTaskState } from "../localagent/types.js";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "tasks-bg-agents";
/** 读 task output 文件时的尾部字节预算 — 限制 v1 渲染开销。 */
const OUTPUT_TAIL_BYTES = 64 * 1024;
/** 渲染时保留的最大行数(头/尾不计)。 */
const OUTPUT_TAIL_LINES = 200;

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
  registerTaskSummaryRenderer(pi);
  installTaskSummaryContextFilter(pi);
  // 剥离 llmVisible:false 的终态通知(同步完成的 local_bash) — 工具结果
  // 已告知 LLM 终态,这类通知只是 TUI/RPC/JSONL 记录,不进 LLM 上下文。
  installTaskNotificationContextFilter(pi);

  // Module-scoped — survives across session_start / session_shutdown
  // reload cycles so we can clean up subscribers from a previous cycle
  // before re-subscribing.
  let unsubPanel: (() => void) | undefined;

  // Panel-visibility latch for the framework poll's output-read gate. TRUE only
  // while the task_output overlay is on screen (the sole surface that actually
  // renders task output — the compact aboveEditor rows are built from `progress`,
  // not polled output). When false, pollTasks does ZERO output reads for running
  // tasks, so an idle pi stays at ~0% CPU even under a firehose local_bash task
  // (pxdev / Puppeteer). See PollTasksOptions.isPanelVisible.
  let panelVisible = false;

  pi.on("session_start", (_event, ctx) => {
    // sessionManager 是 ReadonlySessionManager —— 取 sessionId 即可,不要 mutate。
    store._setSessionId(ctx.sessionManager.getSessionId());
    _resetTaskOutputDirForTest();
    // 无 UI(headless / RPC)时 panelVisible 恒 false → poll 永不读输出;
    // 模型看子 agent 输出走 task_status 按需读取路径,不受影响。
    startTaskFrameworkPolling(store, deps.pollIntervalMs, {
      isPanelVisible: () => panelVisible,
    });
    pi.registerTool(buildTaskKillTool(store));
    pi.registerTool(buildTaskStatusTool(store));
    pi.registerTool(buildTaskListTool(store));

    if (!ctx.hasUI) return;

    // Defensive: clean up any subs leaked from a previous cycle.
    unsubPanel?.();

    const viewState = createTaskPanelViewStateStore();
    let tuiHandle: TUI | undefined;
    const innerFactory = buildTaskPanel({ taskStore: store, viewState });
    const componentFactory = (
      t: TUI,
      theme: Theme,
    ): Component & { dispose?(): void } => {
      tuiHandle = t;
      const component = innerFactory(t, theme);
      const origDispose = component.dispose;
      return {
        ...component,
        render: (width: number) => component.render(width),
        dispose: () => {
          tuiHandle = undefined;
          origDispose?.();
        },
      };
    };
    ctx.ui.setWidget(WIDGET_KEY, componentFactory, {
      placement: "aboveEditor",
    });

    const requestRender = (): void => {
      tuiHandle?.requestRender();
    };

    const u1 = store.subscribe(requestRender);

    const unsubKeybindings = registerTaskPanelKeybindings({
      ui: ctx.ui,
      taskStore: store,
      viewState,
    });

    // task_output overlay reactor — open a full-screen ctx.ui.custom overlay
    // when the user enters task_output mode, dismiss when leaving. Mirrors
    // the teammate overlay pattern (commit 725e268). nonCapturing:true so
    // the editor keeps focus and Esc still routes through onTerminalInput.
    let overlayHandle: OverlayHandle | undefined;
    let overlayDone: ((value: void) => void) | undefined;
    function dismissOverlay(): void {
      if (overlayDone) {
        try {
          overlayDone();
        } catch (e) {
          logError(e, "task panel overlay done");
        }
        overlayDone = undefined;
      }
      if (overlayHandle) {
        try {
          overlayHandle.hide();
        } catch (e) {
          logError(e, "task panel overlay hide");
        }
        overlayHandle = undefined;
      }
    }

    const unsubViewState = viewState.subscribe((state) => {
      // Flip the poll's output-read gate: reads happen only while the
      // task_output overlay is up. Closing it (any other kind) reverts to
      // zero output reads for running tasks.
      panelVisible = state.kind === "task_output";
      requestRender();
      if (state.kind === "task_output") {
        if (overlayHandle || overlayDone) return;
        const taskId = state.taskId;
        const overlayPromise = ctx.ui.custom<void>(
          (_tui, theme, _kb, done) => {
            overlayDone = done;
            const themeFg = (
              theme as unknown as {
                fg?: (color: string, text: string) => string;
              }
            ).fg;
            const overlayTheme: TaskOutputOverlayTheme | undefined =
              typeof themeFg === "function"
                ? {
                    fg: (color: string, text: string) =>
                      themeFg.call(theme, color, text),
                  }
                : undefined;
            return buildTaskOutputOverlayComponent({
              taskId,
              getTask: () => snapshotEntry(store, taskId),
              getOutputContent: () => readTaskOutputTail(store, taskId),
              theme: overlayTheme,
            });
          },
          {
            overlay: true,
            overlayOptions: () => ({
              width: "100%",
              maxHeight: "100%",
              anchor: "top-left",
              margin: 0,
              // nonCapturing:true so the editor keeps focus and Esc routes
              // through onTerminalInput → exitTaskView (mirrors commit
              // 725e268's teammate-overlay fix).
              nonCapturing: true,
            }),
            onHandle: (h) => {
              overlayHandle = h;
            },
          },
        );
        if (overlayPromise && typeof overlayPromise.then === "function") {
          overlayPromise.then(
            () => {
              overlayHandle = undefined;
              overlayDone = undefined;
            },
            (e: unknown) => {
              overlayHandle = undefined;
              overlayDone = undefined;
              logError(e, "task panel overlay promise");
            },
          );
        }
      } else {
        dismissOverlay();
      }
    });

    unsubPanel = (): void => {
      u1();
      unsubKeybindings();
      unsubViewState();
      dismissOverlay();
      panelVisible = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    };
  });

  pi.on("session_shutdown", async () => {
    unsubPanel?.();
    unsubPanel = undefined;
    panelVisible = false;
    stopTaskFrameworkPolling();
    // 等待所有 in-flight 写盘 settle,避免 async-ENOENT-after-teardown。
    await _clearOutputsForTest();
    store._resetForTest();
    _resetTaskTypeRegistryForTest();
  });
}

function snapshotEntry(store: TaskStore, taskId: string): TaskPanelEntry | undefined {
  const t = store.getTask(taskId);
  if (!t || t.type !== "local_agent") return undefined;
  const la = t as LocalAgentTaskState;
  return {
    id: la.id,
    type: la.type,
    description: la.description,
    status: la.status,
    startTime: la.startTime,
    tokenCount: la.progress?.tokenCount ?? 0,
    toolCallCount: la.progress?.toolCallCount ?? 0,
  };
}

function readTaskOutputTail(store: TaskStore, taskId: string): string {
  const task = store.getTask(taskId);
  if (!task) return "";
  try {
    // readFileSync with no length arg reads the whole file; we keep it
    // simple for v1 and rely on diskOutput's own size cap (5GB) plus our
    // own line truncation below. If perf becomes an issue we can switch
    // to a stat + tail-byte read pattern.
    const buf = readFileSync(task.outputFile);
    // Prefer the LAST OUTPUT_TAIL_BYTES bytes — avoids loading 100 MB into
    // a string when the file is large.
    const slice =
      buf.length > OUTPUT_TAIL_BYTES
        ? buf.subarray(buf.length - OUTPUT_TAIL_BYTES)
        : buf;
    const text = slice.toString("utf8");
    const lines = text.split("\n");
    if (lines.length <= OUTPUT_TAIL_LINES) return text;
    return lines.slice(lines.length - OUTPUT_TAIL_LINES).join("\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    logError(e, "task panel readTaskOutputTail");
    return "";
  }
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
  POLL_MAX_READ_BYTES,
  pollTasks,
  registerTask,
  startTaskFrameworkPolling,
  stopTaskFrameworkPolling,
  STOPPED_DISPLAY_MS,
  updateTaskState,
} from "./framework.js";
export type { PollTasksOptions } from "./framework.js";

export {
  appendTaskOutput,
  cleanupTaskOutput,
  DiskTaskOutput,
  evictTaskOutput,
  flushTaskOutput,
  getMaxTaskOutputBytes,
  getTaskOutput,
  getTaskOutputDelta,
  getTaskOutputTailDelta,
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
  installTaskNotificationContextFilter,
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

export type {
  TaskSummaryDetails,
  TaskSummaryTimelineEntry,
} from "./summary.js";
export {
  emitTaskSummary,
  installTaskSummaryContextFilter,
  registerTaskSummaryRenderer,
  TASK_SUMMARY_CUSTOM_TYPE,
} from "./summary.js";

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
