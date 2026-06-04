import { describe, it, expect, vi } from "vitest";
import { createViewStateStore } from "./viewState.js";

describe("viewStateStore", () => {
  it("initial state is leader (blurred)", () => {
    const store = createViewStateStore();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
  });

  it("selectAgent transitions to leader_with_selection (focused inherits prev)", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });
  });

  it("selectAgent overrides any current state", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    expect(store.get()).toEqual({ kind: "teammate", agentId: "a" });
    store.selectAgent("b");
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "b",
      focused: false,
    });
  });

  it("cycleSelection next from leader picks the first agent", () => {
    const store = createViewStateStore();
    store.cycleSelection("next", ["a", "b", "c"]);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });
  });

  it("cycleSelection next from leader_with_selection wraps", () => {
    const store = createViewStateStore();
    const agents = ["a", "b", "c"];
    store.selectAgent("a");
    store.cycleSelection("next", agents);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "b",
      focused: false,
    });
    store.cycleSelection("next", agents);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "c",
      focused: false,
    });
    store.cycleSelection("next", agents);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });
  });

  it("cycleSelection prev from leader_with_selection wraps in reverse", () => {
    const store = createViewStateStore();
    const agents = ["a", "b", "c"];
    store.selectAgent("a");
    store.cycleSelection("prev", agents);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "c",
      focused: false,
    });
    store.cycleSelection("prev", agents);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "b",
      focused: false,
    });
    store.cycleSelection("prev", agents);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });
  });

  it("cycleSelection prev from leader picks the last agent", () => {
    const store = createViewStateStore();
    store.cycleSelection("prev", ["a", "b", "c"]);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "c",
      focused: false,
    });
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
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });
  });

  it("enterTeammateView from leader_with_selection enters teammate view (drops focused)", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.toggleFocus();
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

  it("exitTeammateView from teammate returns to leader_with_selection focused=true", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    store.exitTeammateView();
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: true,
    });
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

  it("reset returns to leader (blurred) from any state", () => {
    const store = createViewStateStore();
    store.reset();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
    store.selectAgent("a");
    store.toggleFocus();
    store.reset();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
    store.selectAgent("b");
    store.enterTeammateView();
    store.reset();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
  });

  it("reset from blurred leader is a no-op (preserves ref)", () => {
    const store = createViewStateStore();
    const before = store.get();
    store.reset();
    expect(store.get()).toBe(before);
  });

  it("toggleFocus on leader flips focused", () => {
    const store = createViewStateStore();
    store.toggleFocus();
    expect(store.get()).toEqual({ kind: "leader", focused: true });
    store.toggleFocus();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
  });

  it("toggleFocus on leader_with_selection flips focused; selection preserved", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.toggleFocus();
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: true,
    });
    store.toggleFocus();
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });
  });

  it("toggleFocus on teammate is a no-op (editor owns focus)", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.enterTeammateView();
    const before = store.get();
    store.toggleFocus();
    expect(store.get()).toBe(before);
  });

  it("cycleSelection preserves the focused flag", () => {
    const store = createViewStateStore();
    store.selectAgent("a");
    store.toggleFocus();
    store.cycleSelection("next", ["a", "b"]);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "b",
      focused: true,
    });
  });

  it("subscribe receives notifications; no-op skipped; unsub stops further", () => {
    const store = createViewStateStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.selectAgent("a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      kind: "leader_with_selection",
      selectedAgentId: "a",
      focused: false,
    });

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
    expect(store.get()).toEqual({ kind: "leader", focused: false });
    store.selectAgent("b");
    expect(listener).not.toHaveBeenCalled();
  });
});
