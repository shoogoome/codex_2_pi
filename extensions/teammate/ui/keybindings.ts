// Wire ctx.ui.onTerminalInput to the view-state store and side effects.
//
// Focus model (mirrors extensions/panel):
//   - focused=false : we only intercept Ctrl+G (toggle-focus). Every other
//                     key passes through to the editor unchanged.
//   - focused=true  : we intercept ↑↓ Tab Enter Esc k as panel controls.
//                     Other keys still pass through (the panel does not own
//                     a text buffer of its own).
//   - teammate view : ALL keys pass through — the swapped editor's
//                     onSubmit/onEscape hooks call deps.onExit which
//                     triggers exitTeammateView(). Pre-empting here would
//                     prevent the user from typing or submitting anything.

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
 * Behavior matrix (state x focused x key):
 *   leader / leader_with_selection, focused=false:
 *     Ctrl+G          → toggleFocus (consume)
 *     anything else   → pass through (undefined)
 *   leader, focused=true:
 *     Ctrl+G          → toggleFocus (consume)
 *     ↑↓Tab           → start cycling (selectAgent first, consume)
 *     Esc             → blur (toggleFocus, consume)
 *     other           → pass through
 *   leader_with_selection, focused=true:
 *     Ctrl+G          → toggleFocus (consume)
 *     ↑↓Tab           → cycle (consume)
 *     Enter           → enterTeammateView (consume)
 *     Esc             → reset (consume)
 *     k               → killTeammate(selected) + reset (consume)
 *     other           → pass through
 *   teammate (focus owned by editor):
 *     ALL keys pass through — the swapped editor's onSubmit/onEscape
 *     hooks call deps.onExit which triggers exitTeammateView().
 */
export function registerTeammateKeybindings(deps: KeybindingsDeps): () => void {
  const handler: TerminalInputHandler = (data) => {
    const action = classifyKey(data);
    const state = deps.viewState.get();

    // Ctrl+G is universal at the leader scope: blurred or focused, it
    // toggles. Teammate view owns its own focus, so Ctrl+G falls through.
    if (action.kind === "toggle-focus") {
      if (state.kind === "teammate") return undefined;
      deps.viewState.toggleFocus();
      return { consume: true };
    }

    // Teammate view: the swapped editor owns ALL keys including Enter/Esc.
    // Its onSubmit/onEscape will trigger viewState.exitTeammateView() via the
    // deps.onExit closure when the user submits empty / hits Esc. The
    // keybindings layer must NOT intercept here — doing so would prevent
    // the user from typing and submitting messages to the teammate.
    if (state.kind === "teammate") {
      return undefined;
    }

    // Blurred panel: every key (other than Ctrl+G handled above) passes
    // through to the editor untouched. The user can type freely.
    if (!state.focused) {
      return undefined;
    }

    // Focused panel from here on.
    const teammates = Object.values(deps.taskStore.get())
      .filter(isInProcessTeammateTask)
      .filter((t) => t.status === "running");
    const activeIds = teammates.map((t) => t.identity.agentId);

    if (state.kind === "leader") {
      if (action.kind === "cycle" && activeIds.length > 0) {
        deps.viewState.cycleSelection(action.direction, activeIds);
        return { consume: true };
      }
      if (action.kind === "esc") {
        // Esc on focused leader = blur.
        deps.viewState.toggleFocus();
        return { consume: true };
      }
      return undefined;
    }

    // state.kind === "leader_with_selection" && focused=true
    if (action.kind === "cycle") {
      if (activeIds.length === 0) return { consume: true };
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
  };

  return deps.ui.onTerminalInput(handler);
}
