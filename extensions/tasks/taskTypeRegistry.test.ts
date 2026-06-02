import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetTaskTypeRegistryForTest,
  getTaskType,
  registerTaskType,
  unregisterTaskType,
} from "./taskTypeRegistry.js";
import type { Task, TaskStoreLike } from "./Task.js";

const fakeTask = (type: Task["type"], name = "FakeTask"): Task => ({
  name,
  type,
  async kill(_taskId: string, _store: TaskStoreLike) {},
});

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetTaskTypeRegistryForTest();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("taskTypeRegistry", () => {
  it("registerTaskType writes; getTaskType reads back the same Task", () => {
    const t = fakeTask("local_bash");
    registerTaskType("local_bash", t);
    expect(getTaskType("local_bash")).toBe(t);
  });

  it("re-registering the same type overrides and emits one console.warn", () => {
    const a = fakeTask("local_bash", "A");
    const b = fakeTask("local_bash", "B");
    registerTaskType("local_bash", a);
    registerTaskType("local_bash", b);
    expect(getTaskType("local_bash")).toBe(b);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("getTaskType returns undefined for unregistered type", () => {
    expect(getTaskType("local_bash")).toBeUndefined();
  });

  it("unregisterTaskType removes the entry", () => {
    registerTaskType("local_bash", fakeTask("local_bash"));
    unregisterTaskType("local_bash");
    expect(getTaskType("local_bash")).toBeUndefined();
  });

  it("unregister of an absent entry does not throw", () => {
    expect(() => unregisterTaskType("local_bash")).not.toThrow();
  });

  it("_resetTaskTypeRegistryForTest empties the registry", () => {
    registerTaskType("local_bash", fakeTask("local_bash"));
    registerTaskType("dream", fakeTask("dream"));
    _resetTaskTypeRegistryForTest();
    expect(getTaskType("local_bash")).toBeUndefined();
    expect(getTaskType("dream")).toBeUndefined();
  });

  it("different types are isolated", () => {
    const a = fakeTask("local_bash", "A");
    const b = fakeTask("dream", "B");
    registerTaskType("local_bash", a);
    registerTaskType("dream", b);
    expect(getTaskType("local_bash")).toBe(a);
    expect(getTaskType("dream")).toBe(b);
  });

  it("registry is a module-level singleton (cross-import sees same state)", async () => {
    const t = fakeTask("local_bash");
    registerTaskType("local_bash", t);
    const reimport = await import("./taskTypeRegistry.js");
    expect(reimport.getTaskType("local_bash")).toBe(t);
  });
});
