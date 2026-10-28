// Wire ctx.ui.onTerminalInput to the task-panel viewState.
//
// Focus model (mirrors the teammate panel pattern):
//   - focused=false : Ctrl+Y toggles focus; everything else passes through.
//                     Ctrl+G is left untouched so the teammate panel sees it.
//   - focused=true  : ↑↓ Tab Enter Esc are intercepted.
//   - task_output   : Esc exits; all other keys go to the child screen.
//                     No detail keystroke can reach the leader editor.

import type {
  ExtensionUIContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../taskStore.js";
import type { TaskPanelViewStateStore } from "./viewState.js";
import type { AgentConversations } from "../agentConversations.js";
import { getTaskPanelEntries } from "./taskPanel.js";

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
  conversations?: AgentConversations;
  detailInput?: (data: string) => void;
}

export function registerTaskPanelKeybindings(
  deps: TaskPanelKeybindingsDeps,
): () => void {
  const handler: TerminalInputHandler = (data) => {
    const action = classifyTaskPanelKey(data);
    const state = deps.viewState.get();

    // Details own every key; never let child input reach the leader editor.
    if (state.kind === "task_output") {
      if (action.kind === "esc") deps.viewState.exitTaskView();
      else deps.detailInput?.(data);
      return { consume: true };
    }

    // Outside details, Ctrl+Y toggles task-panel focus.
    if (action.kind === "toggle-task-focus") {
      deps.viewState.toggleFocus();
      return { consume: true };
    }

    // Blurred panel: keys (other than Ctrl+Y handled above) pass through
    // to the editor untouched. The user can type freely; the teammate
    // panel still gets Ctrl+G unchanged.
    if (!state.focused) {
      return undefined;
    }

    // Focused leader / leader_with_selection from here on.
    const runningIds = getTaskPanelEntries(deps, true).map((t) => t.id);

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
      if (!runningIds.includes(state.selectedTaskId)) {
        if (!runningIds.length) { deps.viewState.reset(); return { consume: true }; }
        deps.viewState.selectTask(runningIds[0]!);
      }
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
