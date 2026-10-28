import { describe, it, expect, vi } from "vitest";
import { createTaskPanelViewStateStore } from "./viewState.js";

describe("taskPanelViewStateStore", () => {
  it("initial state is leader (blurred)", () => {
    const store = createTaskPanelViewStateStore();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
  });

  it("selectTask transitions to leader_with_selection (focused inherited)", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a1");
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a1",
      focused: false,
    });
  });

  it("selectTask preserves focused from leader", () => {
    const store = createTaskPanelViewStateStore();
    store.toggleFocus();
    store.selectTask("a1");
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a1",
      focused: true,
    });
  });

  it("cycleSelection next from leader picks first id", () => {
    const store = createTaskPanelViewStateStore();
    store.cycleSelection("next", ["a", "b", "c"]);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a",
      focused: false,
    });
  });

  it("cycleSelection prev from leader picks last id", () => {
    const store = createTaskPanelViewStateStore();
    store.cycleSelection("prev", ["a", "b", "c"]);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "c",
      focused: false,
    });
  });

  it("cycleSelection wraps around in next direction", () => {
    const store = createTaskPanelViewStateStore();
    const ids = ["a", "b", "c"];
    store.selectTask("c");
    store.cycleSelection("next", ids);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a",
      focused: false,
    });
  });

  it("cycleSelection wraps around in prev direction", () => {
    const store = createTaskPanelViewStateStore();
    const ids = ["a", "b", "c"];
    store.selectTask("a");
    store.cycleSelection("prev", ids);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "c",
      focused: false,
    });
  });

  it("cycleSelection in task_output is a no-op", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a");
    store.enterTaskView();
    const before = store.get();
    store.cycleSelection("next", ["a", "b"]);
    expect(store.get()).toBe(before);
  });

  it("cycleSelection with empty ids is a no-op", () => {
    const store = createTaskPanelViewStateStore();
    const before = store.get();
    store.cycleSelection("next", []);
    expect(store.get()).toBe(before);
  });

  it("cycleSelection where selected id vanished picks first", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("ghost");
    store.cycleSelection("next", ["a", "b"]);
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a",
      focused: false,
    });
  });

  it("enterTaskView from leader_with_selection enters task_output", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a");
    store.toggleFocus();
    store.enterTaskView();
    expect(store.get()).toEqual({ kind: "task_output", taskId: "a" });
  });

  it("enterTaskView from leader is a no-op", () => {
    const store = createTaskPanelViewStateStore();
    const before = store.get();
    store.enterTaskView();
    expect(store.get()).toBe(before);
  });

  it("exitTaskView returns input ownership to the leader editor", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a");
    store.enterTaskView();
    store.exitTaskView();
    expect(store.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a",
      focused: false,
    });
  });

  it("reset returns to leader (blurred)", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a");
    store.toggleFocus();
    store.reset();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
  });

  it("reset from blurred leader is a no-op (preserves ref)", () => {
    const store = createTaskPanelViewStateStore();
    const before = store.get();
    store.reset();
    expect(store.get()).toBe(before);
  });

  it("toggleFocus on leader flips focused", () => {
    const store = createTaskPanelViewStateStore();
    store.toggleFocus();
    expect(store.get()).toEqual({ kind: "leader", focused: true });
    store.toggleFocus();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
  });

  it("toggleFocus on task_output is a no-op", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a");
    store.enterTaskView();
    const before = store.get();
    store.toggleFocus();
    expect(store.get()).toBe(before);
  });

  it("subscribe receives notifications; no-op skipped; unsub stops further", () => {
    const store = createTaskPanelViewStateStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.selectTask("a");
    expect(listener).toHaveBeenCalledTimes(1);

    store.cycleSelection("next", []); // no-op
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    store.selectTask("b");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("_resetForTest returns initial and clears listeners", () => {
    const store = createTaskPanelViewStateStore();
    store.selectTask("a");
    const listener = vi.fn();
    store.subscribe(listener);
    store._resetForTest();
    expect(store.get()).toEqual({ kind: "leader", focused: false });
    store.selectTask("b");
    expect(listener).not.toHaveBeenCalled();
  });
});
