import { describe, it, expect, vi } from "vitest";
import { createViewStateStore } from "./viewState.js";

describe("viewStateStore", () => {
  it("initial state is leader", () => {
    const store = createViewStateStore();
    expect(store.get()).toEqual({ kind: "leader" });
  });

  it("selectAgent transitions to leader_with_selection", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "a" });
  });

  it("selectAgent overrides any current state", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    expect(store.get()).toEqual({ kind: "teammate", agentId: "a" });
    store.selectAgent("b");
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "b" });
  });

  it("cycleSelection next from leader picks the first agent", () => {
    const store = createViewStateStore();
    store.cycleSelection("next", ["a", "b", "c"]);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "a" });
  });

  it("cycleSelection next from leader_with_selection wraps", () => {
    const store = createViewStateStore();
    const agents = ["a", "b", "c"];
    store.selectAgent("a");
    store.cycleSelection("next", agents);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "b" });
    store.cycleSelection("next", agents);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "c" });
    store.cycleSelection("next", agents);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "a" });
  });

  it("cycleSelection prev from leader_with_selection wraps in reverse", () => {
    const store = createViewStateStore();
    const agents = ["a", "b", "c"];
    store.selectAgent("a");
    store.cycleSelection("prev", agents);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "c" });
    store.cycleSelection("prev", agents);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "b" });
    store.cycleSelection("prev", agents);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "a" });
  });

  it("cycleSelection prev from leader picks the last agent", () => {
    const store = createViewStateStore();
    store.cycleSelection("prev", ["a", "b", "c"]);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "c" });
  });

  it("cycleSelection in teammate view is a no-op", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    const before = store.get();
    store.cycleSelection("next", ["a", "b", "c"]);
    expect(store.get()).toBe(before);
    store.cycleSelection("prev", ["a", "b", "c"]);
    expect(store.get()).toBe(before);
  });

  it("cycleSelection with empty agents is a no-op", () => {
    const store = createViewStateStore();
    const before = store.get();
    store.cycleSelection("next", []);
    expect(store.get()).toBe(before);
    store.selectAgent("a");
    const mid = store.get();
    store.cycleSelection("next", []);
    expect(store.get()).toBe(mid);
  });

  it("cycleSelection where selected agent vanished from list picks first", () => {
    const store = createViewStateStore();
    store.selectAgent("ghost");
    store.cycleSelection("next", ["a", "b"]);
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "a" });
  });

  it("enterTeammateView from leader_with_selection enters teammate view", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    expect(store.get()).toEqual({ kind: "teammate", agentId: "a" });
  });

  it("enterTeammateView from leader is a no-op", () => {
    const store = createViewStateStore();
    const before = store.get();
    store.enterTeammateView();
    expect(store.get()).toBe(before);
  });

  it("enterTeammateView from teammate is a no-op", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    const before = store.get();
    store.enterTeammateView();
    expect(store.get()).toBe(before);
  });

  it("exitTeammateView from teammate returns to leader_with_selection preserving agentId", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    store.exitTeammateView();
    expect(store.get()).toEqual({ kind: "leader_with_selection", selectedAgentId: "a" });
  });

  it("exitTeammateView from leader is a no-op", () => {
    const store = createViewStateStore();
    const before = store.get();
    store.exitTeammateView();
    expect(store.get()).toBe(before);
  });

  it("exitTeammateView from leader_with_selection is a no-op", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    const before = store.get();
    store.exitTeammateView();
    expect(store.get()).toBe(before);
  });

  it("reset returns to leader from any state", () => {
    const store = createViewStateStore();
    store.reset();
    expect(store.get()).toEqual({ kind: "leader" });
    store.selectAgent("a");
    store.reset();
    expect(store.get()).toEqual({ kind: "leader" });
    store.selectAgent("b");
    store.enterTeammateView();
    store.reset();
    expect(store.get()).toEqual({ kind: "leader" });
  });

  it("reset from leader is a no-op (preserves ref)", () => {
    const store = createViewStateStore();
    const before = store.get();
    store.reset();
    expect(store.get()).toBe(before);
  });

  it("subscribe receives notifications; no-op skipped; unsub stops further", () => {
    const store = createViewStateStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.selectAgent("a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ kind: "leader_with_selection", selectedAgentId: "a" });

    // No-op: enterTeammateView from leader (after reset)
    store.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    store.enterTeammateView(); // no-op from leader
    expect(listener).toHaveBeenCalledTimes(2);

    // No-op: exitTeammateView from leader
    store.exitTeammateView();
    expect(listener).toHaveBeenCalledTimes(2);

    // No-op: cycleSelection with empty agents
    store.cycleSelection("next", []);
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    store.selectAgent("z");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("_resetForTest returns initial state and clears listeners", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store._resetForTest();
    expect(store.get()).toEqual({ kind: "leader" });
    store.selectAgent("b");
    expect(listener).not.toHaveBeenCalled();
  });
});
