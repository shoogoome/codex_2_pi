import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setDefaultTaskStoreForTest,
  createTaskStore,
  getDefaultTaskStore,
  setDefaultTaskStore,
  type TaskStore,
} from "./taskStore.js";
import type { TaskStateBase } from "./Task.js";

const sampleTask = (id: string, status: TaskStateBase["status"] = "running"): TaskStateBase => ({
  id,
  type: "local_bash",
  status,
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
});

describe("createTaskStore", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = createTaskStore();
  });

  it("starts with empty snapshot and default sessionId", () => {
    expect(store.get()).toEqual({});
    expect(store.getSessionId()).toBe("default-session");
  });

  it("set with updater inserts task and notifies listener", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    const task = sampleTask("babcdefgh");
    store.set((prev) => ({ ...prev, [task.id]: task }));

    expect(store.getTask("babcdefgh")).toBe(task);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ babcdefgh: task });
  });

  it("set with no-op updater (returns prev) does NOT notify listener", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((prev) => prev);
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe does NOT immediately call listener", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("multiple listeners all receive the same snapshot synchronously", () => {
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    const task = sampleTask("babcdefgh");
    store.set(() => ({ [task.id]: task }));
    expect(a).toHaveBeenCalledWith({ babcdefgh: task });
    expect(b).toHaveBeenCalledWith({ babcdefgh: task });
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set(() => ({ [sampleTask("first").id]: sampleTask("first") }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set(() => ({ [sampleTask("second").id]: sampleTask("second") }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("getTask returns undefined for unknown id", () => {
    expect(store.getTask("nope")).toBeUndefined();
  });

  it("_setSessionId reflects in getSessionId immediately", () => {
    store._setSessionId("session-xyz");
    expect(store.getSessionId()).toBe("session-xyz");
  });

  it("_resetForTest clears tasks, listeners, and sessionId", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store._setSessionId("session-xyz");
    store.set(() => ({ [sampleTask("babcdefgh").id]: sampleTask("babcdefgh") }));
    expect(listener).toHaveBeenCalledTimes(1);

    store._resetForTest();
    expect(store.get()).toEqual({});
    expect(store.getSessionId()).toBe("default-session");

    store.set(() => ({ [sampleTask("again").id]: sampleTask("again") }));
    // listener was cleared by _resetForTest — should not fire again.
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("default global store", () => {
  afterEach(() => {
    _setDefaultTaskStoreForTest(undefined);
  });

  it("getDefaultTaskStore throws when not set", () => {
    _setDefaultTaskStoreForTest(undefined);
    expect(() => getDefaultTaskStore()).toThrow(/default TaskStore not initialised/);
  });

  it("setDefaultTaskStore makes store retrievable", () => {
    const store = createTaskStore();
    setDefaultTaskStore(store);
    expect(getDefaultTaskStore()).toBe(store);
  });

  it("_setDefaultTaskStoreForTest can clear default", () => {
    setDefaultTaskStore(createTaskStore());
    _setDefaultTaskStoreForTest(undefined);
    expect(() => getDefaultTaskStore()).toThrow();
  });
});
