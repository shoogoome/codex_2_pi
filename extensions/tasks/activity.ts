import type { TaskOrigin } from "./origin.js";
import { copyTaskOrigin } from "./origin.js";

/** Content-free execution window. cwd is actual execution cwd, not root cwd. */
export interface TaskActivity extends TaskOrigin {
  readonly taskId: string;
  readonly operationId: string;
  readonly cwd: string;
}
export interface TaskActivityEvent extends TaskActivity {
  readonly phase: "before-start" | "end";
}
export type TaskActivityListener = (event: TaskActivityEvent) => void | Promise<void>;
export interface TaskActivityHandle {
  subscribe(listener: TaskActivityListener): () => void;
  getActive(): readonly TaskActivity[];
  /** A baseline barrier: callers MUST await before executing any work. */
  begin(activity: TaskActivity): Promise<void>;
  end(activity: TaskActivity): Promise<void>;
}

export function createTaskActivityHandle(): TaskActivityHandle {
  const listeners = new Set<TaskActivityListener>();
  const active = new Map<string, TaskActivity>();
  const starting = new Map<string, Promise<void>>();
  const ending = new Map<string, Promise<void>>();
  const key = (a: TaskActivity) => JSON.stringify([a.originSessionId, a.taskId, a.operationId]);
  const emit = async (a: TaskActivity, phase: TaskActivityEvent["phase"]) => {
    // All listeners see the signal even when one fails; reject the start barrier
    // so work cannot silently outrun a failed baseline.
    const results = await Promise.allSettled([...listeners].map(async (listener) => {
      if (listeners.has(listener)) await listener(Object.freeze({ ...a, phase }));
    }));
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  const hub: TaskActivityHandle = {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getActive: () => [...active.values()],
    begin(input) {
      if (!input.originSessionId) return Promise.resolve();
      const id = key(input);
      if (starting.has(id)) return starting.get(id)!;
      if (active.has(id)) return Promise.resolve();
      const a = Object.freeze({ ...copyTaskOrigin(input), taskId: input.taskId, operationId: input.operationId, cwd: input.cwd });
      const promise = emit(a, "before-start").then(() => { active.set(id, a); }).catch(async (error) => {
        // Release any consumers which opened their window before another
        // listener rejected; this operation will never execute.
        await emit(a, "end").catch(() => {});
        throw error;
      }).finally(() => { starting.delete(id); });
      starting.set(id, promise);
      return promise;
    },
    end(input) {
      const id = key(input);
      if (ending.has(id)) return ending.get(id)!;
      const promise = (async () => {
        await starting.get(id)?.catch(() => {});
        const a = active.get(id);
        if (!a) return;
        active.delete(id);
        await emit(a, "end");
      })().finally(() => { ending.delete(id); });
      ending.set(id, promise);
      return promise;
    },
  };
  return hub;
}

const KEY = Symbol.for("pi.tasks.activity.v1");
/** Shared across child-session EventBuses and extension module realms. */
export function getTaskActivityHandle(): TaskActivityHandle {
  const host = globalThis as unknown as Record<symbol, TaskActivityHandle>;
  return host[KEY] ??= createTaskActivityHandle();
}
