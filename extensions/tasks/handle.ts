// Cross-extension tasks handle — solves Pi extension module-realm isolation.
//
// Pi loads each extension via a fresh jiti instance with moduleCache:false,
// so module-level singletons (e.g. _defaultStore in taskStore.ts) DO NOT
// share across extensions. Pi 0.84+ also gives each extension its own
// `pi.events` facade, so writing extra properties there is invisible to
// consumers. attachSessionHandle publishes on the shared EventBus instead.
//
// Tasks extension MUST attach the handle in its sync extension body (before
// any session_start fires). Other extensions (localshell, LocalAgent,
// Teammate, Dream) MUST read the handle inside their session_start handler.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachSessionHandle, getSessionHandle } from "../shared/sessionHandle.js";
import type { Task, TaskType } from "./Task.js";
import { setDefaultTaskStore, type TaskStore } from "./taskStore.js";

import { getTaskActivityHandle, type TaskActivityHandle } from "./activity.js";

const HANDLE_KEY = "__pi_tasks_handle__";

export interface TasksHandle {
  activity: TaskActivityHandle;
  store: TaskStore;
  registerTaskType(type: TaskType, task: Task): void;
  getTaskType(type: TaskType): Task | undefined;
  unregisterTaskType(type: TaskType): void;
}

/** Publish the handle so cross-extension consumers can find it. */
export function attachTasksHandle(pi: ExtensionAPI, handle: Omit<TasksHandle, "activity"> & Partial<Pick<TasksHandle, "activity">>): void {
  attachSessionHandle(pi, HANDLE_KEY, { ...handle, activity: handle.activity ?? getTaskActivityHandle() });
}

/** Read the handle; throws if tasks extension hasn't attached yet. */
export function getTasksHandle(pi: ExtensionAPI): TasksHandle {
  const handle = getSessionHandle<TasksHandle>(pi, HANDLE_KEY);
  if (!handle) {
    throw new Error(
      "pi-tasks-extension handle not found on pi.events. Ensure pi-tasks-extension is installed and loaded.",
    );
  }
  // Mirror the store into THIS module realm's default-store slot. This is
  // safe because setDefaultTaskStore writes a single ref; multiple realms
  // each write their own _defaultStore variable but they all point to the
  // SAME store object, so reads stay consistent.
  // Without this mirroring, internal helpers in tasks/ that call
  // getDefaultTaskStore() (e.g. outputPath.getTaskOutputDir, diskOutput helpers)
  // throw because the consumer extension's realm never had its _defaultStore set.
  setDefaultTaskStore(handle.store);
  return handle;
}

/**
 * A `TaskStore` that re-resolves the real store on every property access.
 *
 * Some extensions must register their tools before they can be sure the tasks
 * extension has attached its handle (tool registration happens in
 * `session_start`, and a throw before `registerTool` would silently remove the
 * tool for the whole session). A lazy store lets registration succeed
 * unconditionally while every actual read/write still goes to the one real
 * store — and still fails loudly if the handle really is absent at use time.
 */
export function lazyTaskStore(pi: ExtensionAPI): TaskStore {
  const resolve = (): TaskStore => getTasksHandle(pi).store;
  return new Proxy({} as TaskStore, {
    get(_target, prop) {
      const store = resolve();
      const value = Reflect.get(store as object, prop, store);
      return typeof value === "function" ? value.bind(store) : value;
    },
    has(_target, prop) {
      return prop in resolve();
    },
    ownKeys() {
      return Reflect.ownKeys(resolve() as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(resolve() as object, prop);
    },
  });
}

/**
 * A `TasksHandle` whose members re-resolve on every access.
 *
 * Same rationale as `lazyTaskStore`: a consumer can hold this from extension
 * load time and never risk a construction-time throw, while a genuinely
 * missing tasks extension still surfaces as an error the moment a real method
 * is invoked.
 */
export function lazyTasksHandle(pi: ExtensionAPI): TasksHandle {
  const resolve = (): TasksHandle => getTasksHandle(pi);
  return {
    get activity() {
      return resolve().activity;
    },
    get store() {
      return resolve().store;
    },
    registerTaskType: (type, task) => resolve().registerTaskType(type, task),
    getTaskType: (type) => resolve().getTaskType(type),
    unregisterTaskType: (type) => resolve().unregisterTaskType(type),
  };
}
