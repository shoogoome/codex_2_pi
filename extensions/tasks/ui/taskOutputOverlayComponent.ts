// Adapter: wraps the pure renderTaskOutputOverlay into a Pi-TUI Component.
//
// `getTask` is called fresh on every render so the header (status,
// elapsed) tracks the latest TaskStore state. `getOutputContent` is
// called fresh on every render so live output appends show up. The
// leader's TaskStore subscriber drives `tui.requestRender()` which
// re-calls our render() — no internal subscription.
//
// When the task vanishes from the store mid-overlay (e.g. evicted post
// terminal grace) we render a "(task missing)" placeholder so the
// overlay doesn't blow up; the keybindings layer should already have
// exited the task_output state, but this is a defensive guard.

import type { Component } from "@earendil-works/pi-tui";
import {
  renderTaskOutputOverlay,
  type TaskOutputOverlayTheme,
} from "./taskOutputOverlayRender.js";
import type { TaskPanelEntry } from "./taskPanelRender.js";

export interface TaskOutputOverlayDeps {
  taskId: string;
  getTask: () => TaskPanelEntry | undefined;
  /** Returns the latest output content (already strip / truncated upstream if desired). */
  getOutputContent: () => string;
  /** Default body height when render() is called without one. */
  defaultHeight?: number;
  /** Optional callback returning the live terminal row count. */
  getHeight?: () => number;
  theme?: TaskOutputOverlayTheme;
}

export interface TaskOutputOverlayComponent extends Component {
  dispose(): void;
}

const FALLBACK_HEIGHT = 200;

const MISSING_TASK: TaskPanelEntry = {
  id: "?",
  type: "local_agent",
  description: "(task missing)",
  status: "killed",
  startTime: 0,
  tokenCount: 0,
  toolCallCount: 0,
};

export function buildTaskOutputOverlayComponent(
  deps: TaskOutputOverlayDeps,
): TaskOutputOverlayComponent {
  return {
    render(width: number): string[] {
      const h = deps.getHeight?.() ?? deps.defaultHeight ?? FALLBACK_HEIGHT;
      const task = deps.getTask() ?? MISSING_TASK;
      const content = deps.getOutputContent();
      return renderTaskOutputOverlay(task, content, width, h, {
        theme: deps.theme,
      });
    },
    invalidate(): void {
      // No internal cache.
    },
    dispose(): void {
      // No resources.
    },
  };
}
