// In-memory store for the leader's TUI view state.
//
// Mirrors the pattern of `extensions/teammate/teamStore.ts`:
//   - Single immutable snapshot ref. Mutators produce a new snapshot.
//   - subscribe listeners fire synchronously after each successful mutation.
//   - No-op mutations keep the same ref and skip listener notifications.
//
// Three view modes the leader can be in:
//   - leader (default)
//   - leader_with_selection (↑↓ highlights a teammate in the widget)
//   - teammate (Enter swaps the editor to teammate context)
//
// Consumed by D.2 (widget highlight), D.3 (keyboard routing) and
// D.4 (view swap).

export type ViewState =
  | { kind: "leader" }
  | { kind: "leader_with_selection"; selectedAgentId: string }
  | { kind: "teammate"; agentId: string };

type Listener = (state: ViewState) => void;

export interface ViewStateStore {
  get(): ViewState;
  subscribe(listener: Listener): () => void;
  reset(): void;
  selectAgent(agentId: string): void;
  cycleSelection(direction: "next" | "prev", availableAgentIds: readonly string[]): void;
  enterTeammateView(): void;
  exitTeammateView(): void;
  _resetForTest(): void;
}

const INITIAL: ViewState = { kind: "leader" };

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
      set((prev) => (prev.kind === "leader" ? prev : { kind: "leader" }));
    },
    selectAgent(agentId) {
      set((prev) => {
        if (prev.kind === "leader_with_selection" && prev.selectedAgentId === agentId) {
          return prev;
        }
        return { kind: "leader_with_selection", selectedAgentId: agentId };
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
        return { kind: "leader_with_selection", selectedAgentId: picked };
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
        return { kind: "leader_with_selection", selectedAgentId: prev.agentId };
      });
    },
    _resetForTest() {
      state = INITIAL;
      listeners.clear();
    },
  };
}
