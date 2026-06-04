// Background-agent panel factory. Mirrors `buildTeamWidget` from the
// teammate extension: returns `(tui, theme) => Component` so it can be
// passed straight into `pi.ui.setWidget(key, factory, options)`.
//
// On every paint the component pulls the latest TaskStore + viewState
// state, filters to local_agent tasks (the panel is the
// "background-agents" panel, mirroring claudecode's "Waiting for N
// background agents to finish"), and renders via `renderTaskPanel`.
//
// We do NOT subscribe internally — the host wires store change ->
// `tui.requestRender()` so re-paints stay centralised.

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../taskStore.js";
import type { TaskPanelViewStateStore } from "./viewState.js";
import {
  renderTaskPanel,
  type TaskPanelEntry,
  type TaskPanelTheme,
} from "./taskPanelRender.js";
import type { LocalAgentTaskState } from "../../localagent/types.js";
import type { TaskStateBase } from "../Task.js";

export interface TaskPanelDeps {
  taskStore: TaskStore;
  viewState: TaskPanelViewStateStore;
}

function isLocalAgentTask(t: TaskStateBase): t is LocalAgentTaskState {
  return t.type === "local_agent";
}

function toEntry(t: LocalAgentTaskState): TaskPanelEntry {
  // `progress` is the live-updating struct populated by spawnLocalAgent's
  // subscribe. Fall back to the task's startTime when absent (e.g. just
  // registered, no progress emitted yet).
  const tokenCount = t.progress?.tokenCount ?? 0;
  const toolCallCount = t.progress?.toolCallCount ?? 0;
  return {
    id: t.id,
    type: t.type,
    description: t.description,
    status: t.status,
    startTime: t.startTime,
    tokenCount,
    toolCallCount,
  };
}

export function buildTaskPanel(deps: TaskPanelDeps) {
  return (
    _tui: TUI,
    theme: Theme,
  ): Component & { dispose?(): void } => {
    // Narrow Pi `Theme` to the minimal `fg`-only surface. Tests pass an
    // empty stub for theme — guard against a missing `fg` member.
    const themeFg = (theme as unknown as Partial<TaskPanelTheme>).fg;
    const renderTheme: TaskPanelTheme =
      typeof themeFg === "function"
        ? {
            fg: (color: string, text: string) =>
              themeFg.call(theme, color, text),
          }
        : { fg: (_c, t) => t };

    return {
      render(width: number): string[] {
        const tasks = Object.values(deps.taskStore.get())
          .filter(isLocalAgentTask)
          .map(toEntry);
        const vs = deps.viewState.get();
        const selectedTaskId =
          vs.kind === "leader_with_selection"
            ? vs.selectedTaskId
            : vs.kind === "task_output"
              ? vs.taskId
              : undefined;
        const focused = vs.kind === "task_output" ? false : vs.focused;
        return renderTaskPanel(tasks, {
          width,
          selectedTaskId,
          focused,
          theme: renderTheme,
        });
      },
      invalidate(): void {
        // No internal cache; render() pulls fresh state on each call.
      },
      dispose(): void {
        // No resources held.
      },
    };
  };
}
