// Task panel view state — tracks focus + selection + task-output overlay
// for the background-agent panel widget. Mirrors the pattern of
// `extensions/teammate/ui/viewState.ts` but simplified for the task panel:
// the panel only owns one mode (leader / leader_with_selection / task_output).
//
// Focus model:
//   - focused=false : keys (other than the panel toggle) pass through to the
//     editor.
//   - focused=true  : ↑↓ Enter Esc are intercepted by the panel.
//   - task_output   : the full-screen overlay owns the screen; Esc exits.
//
// Mutator return semantics: a mutator that would produce an identical
// snapshot returns the previous ref so subscribers are NOT notified
// (mirrors teammate viewState).

export type TaskPanelViewState =
  | { kind: "leader"; focused: boolean }
  | {
      kind: "leader_with_selection";
      selectedTaskId: string;
      focused: boolean;
    }
  | { kind: "task_output"; taskId: string };

type Listener = (state: TaskPanelViewState) => void;

export interface TaskPanelViewStateStore {
  get(): TaskPanelViewState;
  subscribe(listener: Listener): () => void;
  toggleFocus(): void;
  selectTask(taskId: string): void;
  cycleSelection(
    direction: "next" | "prev",
    availableIds: readonly string[],
  ): void;
  enterTaskView(): void;
  exitTaskView(): void;
  reset(): void;
  _resetForTest(): void;
}

const INITIAL: TaskPanelViewState = { kind: "leader", focused: false };

export function createTaskPanelViewStateStore(): TaskPanelViewStateStore {
  let state: TaskPanelViewState = INITIAL;
  const listeners = new Set<Listener>();

  function set(updater: (prev: TaskPanelViewState) => TaskPanelViewState): boolean {
    const prev = state;
    const next = updater(prev);
    if (next === prev) return false;
    state = next;
    for (const listener of Array.from(listeners)) {
      listener(state);
    }
    return true;
  }

  function nextSelection(
    direction: "next" | "prev",
    currentId: string | undefined,
    ids: readonly string[],
  ): string {
    if (currentId === undefined) {
      return direction === "next" ? ids[0]! : ids[ids.length - 1]!;
    }
    const idx = ids.indexOf(currentId);
    if (idx === -1) {
      return ids[0]!;
    }
    const len = ids.length;
    const nextIdx = direction === "next" ? (idx + 1) % len : (idx - 1 + len) % len;
    return ids[nextIdx]!;
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggleFocus() {
      set((prev) => {
        if (prev.kind === "task_output") return prev;
        return { ...prev, focused: !prev.focused };
      });
    },
    selectTask(taskId) {
      set((prev) => {
        if (
          prev.kind === "leader_with_selection" &&
          prev.selectedTaskId === taskId
        ) {
          return prev;
        }
        const focused =
          prev.kind === "leader_with_selection" || prev.kind === "leader"
            ? prev.focused
            : false;
        return { kind: "leader_with_selection", selectedTaskId: taskId, focused };
      });
    },
    cycleSelection(direction, availableIds) {
      set((prev) => {
        if (availableIds.length === 0) return prev;
        if (prev.kind === "task_output") return prev;
        const currentId =
          prev.kind === "leader_with_selection" ? prev.selectedTaskId : undefined;
        const picked = nextSelection(direction, currentId, availableIds);
        if (
          prev.kind === "leader_with_selection" &&
          prev.selectedTaskId === picked
        ) {
          return prev;
        }
        const focused = prev.kind === "leader" || prev.kind === "leader_with_selection"
          ? prev.focused
          : false;
        return { kind: "leader_with_selection", selectedTaskId: picked, focused };
      });
    },
    enterTaskView() {
      set((prev) => {
        if (prev.kind !== "leader_with_selection") return prev;
        return { kind: "task_output", taskId: prev.selectedTaskId };
      });
    },
    exitTaskView() {
      set((prev) => {
        if (prev.kind !== "task_output") return prev;
        return {
          kind: "leader_with_selection",
          selectedTaskId: prev.taskId,
          // Returning from a child must return Enter to the leader editor.
          // Keeping the invisible picker focused would reopen the task when
          // the user tries to submit a prompt or /reload.
          focused: false,
        };
      });
    },
    reset() {
      set((prev) =>
        prev.kind === "leader" && prev.focused === false
          ? prev
          : { kind: "leader", focused: false },
      );
    },
    _resetForTest() {
      state = INITIAL;
      listeners.clear();
    },
  };
}
