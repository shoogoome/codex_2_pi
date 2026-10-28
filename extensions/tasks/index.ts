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
import { getTaskActivityHandle } from "./activity.js";
import { createAgentCapacity } from "./agentCapacity.js";
import { attachAgentCapacity } from "./agentCapacityHandle.js";
import { logError } from "./logging.js";
import { createAgentConversations } from "./agentConversations.js";
import { buildTaskPanel } from "./ui/taskPanel.js";
import { createTaskPanelViewStateStore } from "./ui/viewState.js";
import { registerTaskPanelKeybindings } from "./ui/taskPanelKeybindings.js";
import { buildTaskOutputOverlayComponent } from "./ui/taskOutputOverlayComponent.js";
import { buildTaskConversationView } from "./ui/taskConversationView.js";
import { loadPiUiRuntime, type PiUiRuntime } from "../shared/pi-ui-runtime.js";
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
  loadUiRuntime?: () => Promise<PiUiRuntime>;
}

export default function tasksExtension(
  pi: ExtensionAPI,
  deps: TasksExtensionDeps = {},
): void {
  const store = deps.storeFactory?.() ?? createTaskStore();
  setDefaultTaskStore(store);

  // Publish handle on the shared EventBus so cross-extension consumers
  // (localshell, localagent, teammate) can find this store + registry even
  // though each extension gets its own pi.events facade and jiti realm.
  const handle: TasksHandle = {
    conversations: createAgentConversations(),
    activity: getTaskActivityHandle(),
    store,
    registerTaskType,
    getTaskType,
    unregisterTaskType,
  };
  attachTasksHandle(pi, handle);
  const agentCapacity = createAgentCapacity();
  attachAgentCapacity(pi, agentCapacity);

  registerTaskNotificationRenderer(pi);
  registerTaskProgressRenderer(pi);
  installProgressContextFilter(pi);
  registerTaskSummaryRenderer(pi);
  installTaskSummaryContextFilter(pi);
  // 剥离 llmVisible:false 的通知（例如默认不唤醒的后台 local_bash 终态）。
  // 这类消息只用于 TUI/RPC/JSONL，不进入 provider payload。
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
    // A replacement/resumed root session gets a fresh capacity accounting
    // generation before localagent/teammate session_start handlers can spawn.
    agentCapacity.reset("Root session replaced");
    handle.conversations.reset();
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

    if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui")) return;

    // Defensive: clean up any subs leaked from a previous cycle.
    unsubPanel?.();

    const viewState = createTaskPanelViewStateStore();
    let tuiHandle: TUI | undefined;
    const innerFactory = buildTaskPanel({ taskStore: store, viewState, conversations: handle.conversations });
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

    let activeView: (Component & { dispose?(): void }) | undefined;
    const unsubKeybindings = registerTaskPanelKeybindings({
      ui: ctx.ui,
      taskStore: store,
      viewState,
      conversations: handle.conversations,
      detailInput: (data) => activeView?.handleInput?.(data),
    });
    let catalog = "";
    const unsubConversations = handle.conversations.subscribe(() => {
      const next = handle.conversations.list().map((r) => r.id + ":" + r.status).join("|");
      if (next !== catalog) { catalog = next; requestRender(); }
    });

    // task_output overlay reactor — open a full-screen ctx.ui.custom overlay
    // when entering task_output. It captures focus; raw input is forwarded by
    // the task keybindings so none of it can mutate the leader editor.
    let overlayHandle: OverlayHandle | undefined;
    let overlayDone: ((value: void) => void) | undefined;
    let opening = false;
    let viewEpoch = 0;
    function dismissOverlay(): void {
      viewEpoch++;
      activeView?.dispose?.();
      activeView = undefined;
      opening = false;
      if (overlayDone) {
        try {
          overlayDone();
        } catch (e) {
          logError(e, "task panel overlay done");
        }
        overlayDone = undefined;
      }
      overlayHandle = undefined;
    }

    const unsubViewState = viewState.subscribe((state) => {
      // Flip the poll's output-read gate: reads happen only while the
      // task_output overlay is up. Closing it (any other kind) reverts to
      // zero output reads for running tasks.
      panelVisible = state.kind === "task_output" && !handle.conversations.get(state.taskId);
      requestRender();
      if (state.kind === "task_output") {
        if (opening || overlayHandle || overlayDone) return;
        opening = true;
        const epoch = ++viewEpoch;
        const taskId = state.taskId;
        const structured = !!handle.conversations.get(taskId);
        const overlayPromise = ctx.ui.custom<void>(
          async (_tui, theme, _kb, done) => {
            overlayDone = done;
            if (structured) {
              try {
                const runtime = await (deps.loadUiRuntime ?? loadPiUiRuntime)();
                if (epoch !== viewEpoch) { done(); return { render: () => [], invalidate() {} }; }
                const view = buildTaskConversationView({
                  taskId, conversations: handle.conversations, runtime,
                  tui: _tui, theme, keybindings: _kb,
                  initialExpanded: ctx.ui.getToolsExpanded?.(),
                  done: () => viewState.exitTaskView(),
                });
                activeView = view;
                return view;
              } catch (error) {
                logError(error, "task conversation UI");
                const text = "子会话 UI 不可用（只读）: " + String(error);
                return { render: (width: number) => [text.slice(0, Math.max(1, Math.floor(width / 2))), "Esc 返回"], invalidate() {} };
              }
            }
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
              getOutputContent: () => "[旧日志视图 / legacy log, read-only]\n" + readTaskOutputTail(store, taskId),
              getHeight: () => _tui.terminal.rows,
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
              // Child details own input, including Enter/q and editing keys.
              nonCapturing: false,
            }),
            onHandle: (h) => {
              overlayHandle = h;
            },
          },
        );
        if (overlayPromise && typeof overlayPromise.then === "function") {
          overlayPromise.then(
            () => {
              if (epoch !== viewEpoch) return;
              activeView?.dispose?.(); activeView = undefined;
              overlayHandle = undefined; overlayDone = undefined; opening = false;
              viewState.exitTaskView();
            },
            (e: unknown) => {
              if (epoch !== viewEpoch) return;
              activeView?.dispose?.(); activeView = undefined;
              overlayHandle = undefined; overlayDone = undefined; opening = false;
              viewState.exitTaskView();
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
      unsubConversations();
      unsubKeybindings();
      unsubViewState();
      dismissOverlay();
      panelVisible = false;
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    };
  });

  pi.on("session_shutdown", async () => {
    handle.conversations.reset();
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
