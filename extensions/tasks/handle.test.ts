import { EventEmitter } from "node:events";
import { attachTasksHandle, getTasksHandle, lazyTasksHandle } from "./handle.js";
import { createTaskStore } from "./taskStore.js";
import { getTaskActivityHandle } from "./activity.js";

it("exposes the same activity hub across isolated event facades and nested session buses", async () => {
  const bus = new EventEmitter();
  const facade = () => ({ events: { emit: (name: string, value: unknown) => { bus.emit(name, value); }, on: (name: string, fn: (value: unknown) => void) => { bus.on(name, fn); return () => bus.off(name, fn); } } }) as never;
  const owner = facade();
  const consumer = facade();
  const minimal = () => ({ store: createTaskStore(), registerTaskType: vi.fn(), getTaskType: vi.fn(), unregisterTaskType: vi.fn() });
  attachTasksHandle(owner, minimal());
  const nested = { events: {} } as never;
  attachTasksHandle(nested, minimal());
  const activity = getTasksHandle(consumer).activity;
  expect(activity).toBe(getTaskActivityHandle());
  expect(getTasksHandle(nested).activity).toBe(activity);
  expect(lazyTasksHandle(consumer).activity).toBe(activity);
  const listener = vi.fn();
  const unsubscribe = activity.subscribe(listener);
  const window = { originSessionId: "handle-root", taskId: "nested", operationId: "run", cwd: "/repo" };
  try {
    await getTasksHandle(nested).activity.begin(window);
    expect(listener).toHaveBeenCalledWith({ ...window, phase: "before-start" });
    expect(activity.getActive()).toContainEqual(window);
    await activity.end(window);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await activity.begin(window); await activity.end(window);
    expect(listener).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); await activity.end(window); }
});
