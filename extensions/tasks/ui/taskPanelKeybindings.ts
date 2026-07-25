// Wire ctx.ui.onTerminalInput to the task-panel viewState.
//
// Focus model (mirrors the teammate panel pattern):
//   - focused=false : Ctrl+Y toggles focus; everything else passes through.
//                     Ctrl+G is left untouched so the teammate panel sees it.
//   - focused=true  : ↑↓ Tab Enter Esc are intercepted.
//   - task_output   : Esc / Enter / 'q' exit; Ctrl+Y is consumed (no-op);
//                     other keys pass through (best-effort harmless until we
//                     add scroll keys).

import type {
  ExtensionUIContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../taskStore.js";
import type { TaskPanelViewStateStore } from "./viewState.js";
import type { LocalAgentTaskState } from "../../localagent/types.js";
import type { TaskStateBase } from "../Task.js";

export type TaskPanelKeyAction =
  | { kind: "toggle-task-focus" }
  | { kind: "cycle"; direction: "next" | "prev" }
  | { kind: "enter" }
  | { kind: "esc" }
  | { kind: "exit-output" }
  | { kind: "ignore" };

// Common terminal escape sequences:
//   "\x19"   = Ctrl+Y (EM)  — toggles task panel focus
//   "\x1b[A" = ↑    "\x1b[B" = ↓    "\x09" = Tab
//   "\r" / "\n"     = Enter
//   "\x1b"   = Esc
export function classifyTaskPanelKey(data: string): TaskPanelKeyAction {
  if (data === "\x19") return { kind: "toggle-task-focus" };
  if (data === "\x1b[A") return { kind: "cycle", direction: "prev" };
  if (data === "\x1b[B") return { kind: "cycle", direction: "next" };
  if (data === "\x09") return { kind: "cycle", direction: "next" };
  if (data === "\r" || data === "\n") return { kind: "enter" };
  if (data === "\x1b") return { kind: "esc" };
  if (data === "q" || data === "Q") return { kind: "exit-output" };
  return { kind: "ignore" };
}

/** Minimal UI surface required by the keybindings layer. */
export type TaskPanelKeybindingsUI = Pick<ExtensionUIContext, "onTerminalInput">;

export interface TaskPanelKeybindingsDeps {
  ui: TaskPanelKeybindingsUI;
  taskStore: TaskStore;
  viewState: TaskPanelViewStateStore;
}

function isLocalAgentTask(t: TaskStateBase): t is LocalAgentTaskState {
  return t.type === "local_agent";
}

export function registerTaskPanelKeybindings(
  deps: TaskPanelKeybindingsDeps,
): () => void {
  const handler: TerminalInputHandler = (data) => {
    const action = classifyTaskPanelKey(data);
    const state = deps.viewState.get();

    // Ctrl+Y is the universal toggle for the task panel. In task_output
    // it's a no-op for viewState.toggleFocus but we still consume it so
    // it doesn't accidentally reach the editor.
    if (action.kind === "toggle-task-focus") {
      deps.viewState.toggleFocus();
      return { consume: true };
    }

    // task_output overlay: Esc / Enter / 'q' exit; everything else falls
    // through. We do NOT swallow other keys because the user might want
    // them to reach an inner editor / scroll handler later.
    if (state.kind === "task_output") {
      if (
        action.kind === "esc" ||
        action.kind === "enter" ||
        action.kind === "exit-output"
      ) {
        deps.viewState.exitTaskView();
        return { consume: true };
      }
      return undefined;
    }

    // Blurred panel: keys (other than Ctrl+Y handled above) pass through
    // to the editor untouched. The user can type freely; the teammate
    // panel still gets Ctrl+G unchanged.
    if (!state.focused) {
      return undefined;
    }

    // Focused leader / leader_with_selection from here on.
    const runningIds = Object.values(deps.taskStore.get())
      .filter(isLocalAgentTask)
      .filter((t) => t.status === "running")
      .sort((a, b) => a.startTime - b.startTime)
      .map((t) => t.id);

    if (state.kind === "leader") {
      if (action.kind === "cycle" && runningIds.length > 0) {
        deps.viewState.cycleSelection(action.direction, runningIds);
        return { consume: true };
      }
      if (action.kind === "esc") {
        deps.viewState.toggleFocus();
        return { consume: true };
      }
      return undefined;
    }

    // state.kind === "leader_with_selection" && focused=true
    if (action.kind === "cycle") {
      if (runningIds.length === 0) return { consume: true };
      deps.viewState.cycleSelection(action.direction, runningIds);
      return { consume: true };
    }
    if (action.kind === "enter") {
      deps.viewState.enterTaskView();
      return { consume: true };
    }
    if (action.kind === "esc") {
      deps.viewState.reset();
      return { consume: true };
    }
    return undefined;
  };

  return deps.ui.onTerminalInput(handler);
}
