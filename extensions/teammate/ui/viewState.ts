// In-memory store for the leader's TUI view state.
//
// Mirrors the pattern of `extensions/teammate/teamStore.ts`:
//   - Single immutable snapshot ref. Mutators produce a new snapshot.
//   - subscribe listeners fire synchronously after each successful mutation.
//   - No-op mutations keep the same ref and skip listener notifications.
//
// View modes the leader can be in:
//   - leader (default)                      — panel may be focused or blurred
//   - leader_with_selection                 — ↑↓ highlights a teammate; focused
//                                             only when the user pressed Ctrl+G
//   - teammate                              — Enter swaps the editor to teammate
//                                             context; the editor owns focus, so
//                                             this state does NOT carry a focus
//                                             flag (the panel is implicitly blurred)
//
// Focus model (mirrors extensions/panel):
//   - focused=false : keys (other than Ctrl+G) pass through to the editor.
//   - focused=true  : ↑↓ Tab Enter Esc k are intercepted by the panel.
//
// Consumed by D.2 (widget highlight), D.3 (keyboard routing) and
// D.4 (view swap).

export type ViewState =
  | { kind: "leader"; focused: boolean }
  | { kind: "leader_with_selection"; selectedAgentId: string; focused: boolean }
  | { kind: "teammate"; agentId: string };

type Listener = (state: ViewState) => void;

export interface ViewStateStore {
  get(): ViewState;
  subscribe(listener: Listener): () => void;
  reset(): void;
  selectAgent(agentId: string): void;
  cycleSelection(direction: "next" | "prev", availableAgentIds: readonly string[]): void;
  /** Focus the panel, selecting the first teammate when none is selected yet. */
  focusWithSelection(availableAgentIds: readonly string[]): void;
  enterTeammateView(): void;
  exitTeammateView(): void;
  toggleFocus(): void;
  _resetForTest(): void;
}

const INITIAL: ViewState = { kind: "leader", focused: false };

export function createViewStateStore(): ViewStateStore {
  let state: ViewState = INITIAL;
  const listeners = new Set<Listener>();

  function set(updater: (prev: ViewState) => ViewState): boolean {
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
    agents: readonly string[],
  ): string {
    if (currentId === undefined) {
      return direction === "next" ? agents[0]! : agents[agents.length - 1]!;
    }
    const idx = agents.indexOf(currentId);
    if (idx === -1) {
      // Selected agent vanished from the list — fall back to the first.
      return agents[0]!;
    }
    const len = agents.length;
    const nextIdx = direction === "next" ? (idx + 1) % len : (idx - 1 + len) % len;
    return agents[nextIdx]!;
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      set((prev) =>
        prev.kind === "leader" && prev.focused === false ? prev : { kind: "leader", focused: false },
      );
    },
    selectAgent(agentId) {
      set((prev) => {
        // Preserve focused on transition from a focused leader_with_selection
        // (re-selecting the same id keeps ref equality so it's a no-op);
        // entering selection from the leader state keeps focused=false.
        if (prev.kind === "leader_with_selection" && prev.selectedAgentId === agentId) {
          return prev;
        }
        const focused =
          prev.kind === "leader_with_selection" || prev.kind === "leader" ? prev.focused : false;
        return { kind: "leader_with_selection", selectedAgentId: agentId, focused };
      });
    },
    cycleSelection(direction, availableAgentIds) {
      set((prev) => {
        if (availableAgentIds.length === 0) return prev;
        if (prev.kind === "teammate") return prev;
        const currentId =
          prev.kind === "leader_with_selection" ? prev.selectedAgentId : undefined;
        const picked = nextSelection(direction, currentId, availableAgentIds);
        if (
          prev.kind === "leader_with_selection" &&
          prev.selectedAgentId === picked
        ) {
          return prev;
        }
        const focused = prev.focused;
        return { kind: "leader_with_selection", selectedAgentId: picked, focused };
      });
    },
    /**
     * Focus the panel and, when nothing is selected yet, park the cursor on the
     * first available teammate.
     *
     * Why focusing alone was not enough: the panel header advertises
     * "↑↓ move · Enter open · Esc back · k kill" as soon as it is focused, but
     * the focused-`leader` state has no `selectedAgentId` — so `Enter` and `k`
     * fell through the handler and reached the EDITOR instead. The user pressed
     * Ctrl+G then `k` and got a literal `k` typed into the input box with the
     * teammate still alive. Selecting on focus makes the advertised keys work
     * immediately; with zero teammates the panel still just focuses (nothing to
     * select), which is the `cycle` path's existing early return.
     */
    focusWithSelection(availableAgentIds: readonly string[]) {
      set((prev) => {
        if (prev.kind === "teammate") return prev;
        if (prev.kind === "leader_with_selection") {
          return prev.focused ? prev : { ...prev, focused: true };
        }
        if (availableAgentIds.length === 0) {
          return prev.focused ? prev : { ...prev, focused: true };
        }
        return {
          kind: "leader_with_selection",
          selectedAgentId: availableAgentIds[0]!,
          focused: true,
        };
      });
    },
    enterTeammateView() {
      set((prev) => {
        if (prev.kind !== "leader_with_selection") return prev;
        return { kind: "teammate", agentId: prev.selectedAgentId };
      });
    },
    exitTeammateView() {
      set((prev) => {
        if (prev.kind !== "teammate") return prev;
        // Returning from teammate view leaves the panel focused so the user
        // can immediately ↑↓ navigate without re-pressing Ctrl+G.
        return { kind: "leader_with_selection", selectedAgentId: prev.agentId, focused: true };
      });
    },
    toggleFocus() {
      set((prev) => {
        if (prev.kind === "teammate") return prev;
        return { ...prev, focused: !prev.focused };
      });
    },
    _resetForTest() {
      state = INITIAL;
      listeners.clear();
    },
  };
}
