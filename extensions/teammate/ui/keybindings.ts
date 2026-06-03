// Wire ctx.ui.onTerminalInput to the view-state store and side effects.
// Two responsibilities:
//   1. Translate raw key bytes (via keyEventClassifier) into viewState
//      mutator calls that drive the widget highlight.
//   2. Side effects when a key implies an action beyond view mutation:
//      "k" kills the currently selected teammate.
//
// Consumed keys (consume:true) prevent Pi's default editor handling; we
// only consume when the key is actually "ours" — i.e. when the current
// view state means the user is navigating teammates, not typing.

import type {
  ExtensionAPI,
  ExtensionUIContext,
  TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../../tasks/taskStore.js";
import type { TeammateHandle } from "../handle.js";
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from "../types.js";
import { killTeammate } from "../killTeammate.js";
import { logError } from "../../tasks/logging.js";
import type { ViewStateStore } from "./viewState.js";
import { classifyKey } from "./keyEventClassifier.js";

/** Minimal UI surface required by the keybindings layer. */
export type KeybindingsUI = Pick<ExtensionUIContext, "onTerminalInput">;

export interface KeybindingsDeps {
  pi: ExtensionAPI;
  ui: KeybindingsUI;
  taskStore: TaskStore;
  handle: TeammateHandle;
  viewState: ViewStateStore;
}

/**
 * Register the teammate keybindings. Returns an unsubscribe.
 *
 * Behavior matrix (state x key):
 *   leader              ↑↓Tab → start cycling (selectAgent first)
 *                       Enter Esc k → ignore (don't consume)
 *   leader_with_selection ↑↓Tab → cycle (consume)
 *                       Enter   → enterTeammateView (consume)
 *                       Esc     → reset (consume)
 *                       k       → killTeammate(selected) + reset (consume)
 *   teammate            Enter   → exitTeammateView (consume)
 *                       Esc     → exitTeammateView (consume)
 *                       (k / cycle ignored — teammate-view typing should pass)
 */
export function registerTeammateKeybindings(deps: KeybindingsDeps): () => void {
  const handler: TerminalInputHandler = (data) => {
    const action = classifyKey(data);
    const state = deps.viewState.get();

    const teammates = Object.values(deps.taskStore.get())
      .filter(isInProcessTeammateTask)
      .filter((t) => t.status === "running");
    const activeIds = teammates.map((t) => t.identity.agentId);

    if (state.kind === "leader") {
      if (action.kind === "cycle" && activeIds.length > 0) {
        deps.viewState.cycleSelection(action.direction, activeIds);
        return { consume: true };
      }
      return undefined;
    }

    if (state.kind === "leader_with_selection") {
      if (action.kind === "cycle") {
        deps.viewState.cycleSelection(action.direction, activeIds);
        return { consume: true };
      }
      if (action.kind === "enter") {
        deps.viewState.enterTeammateView();
        return { consume: true };
      }
      if (action.kind === "esc") {
        deps.viewState.reset();
        return { consume: true };
      }
      if (action.kind === "kill") {
        const selectedId = state.selectedAgentId;
        const task: InProcessTeammateTaskState | undefined = teammates.find(
          (t) => t.identity.agentId === selectedId,
        );
        if (task) {
          void killTeammate(deps.pi, deps.taskStore, deps.handle, task.id).catch(
            (e) => {
              logError(e, "registerTeammateKeybindings kill");
            },
          );
        }
        deps.viewState.reset();
        return { consume: true };
      }
      return undefined;
    }

    // state.kind === "teammate"
    if (action.kind === "enter" || action.kind === "esc") {
      deps.viewState.exitTeammateView();
      return { consume: true };
    }
    return undefined;
  };

  return deps.ui.onTerminalInput(handler);
}
