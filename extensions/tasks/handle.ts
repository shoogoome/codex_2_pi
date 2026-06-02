// Cross-extension tasks handle — solves Pi extension module-realm isolation.
//
// Pi loads each extension via a fresh jiti instance with moduleCache:false,
// so module-level singletons (e.g. _defaultStore in taskStore.ts) DO NOT
// share across extensions. But pi.events (EventBus) IS the same object
// across all extensions. We attach the framework handle as a property on
// pi.events, giving any extension a stable lookup.
//
// Tasks extension MUST attach the handle in its sync extension body (before
// any session_start fires). Other extensions (localshell, future LocalAgent,
// Teammate, Dream) MUST read the handle inside their session_start handler.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Task, TaskType } from "./Task.js";
import { setDefaultTaskStore, type TaskStore } from "./taskStore.js";

/** Symbol-keyed property to avoid name collisions on the EventBus object. */
const HANDLE_KEY = "__pi_tasks_handle__";

export interface TasksHandle {
  store: TaskStore;
  registerTaskType(type: TaskType, task: Task): void;
  getTaskType(type: TaskType): Task | undefined;
  unregisterTaskType(type: TaskType): void;
}

/** Attach the handle on pi.events so cross-extension consumers can find it. */
export function attachTasksHandle(pi: ExtensionAPI, handle: TasksHandle): void {
  (pi.events as unknown as Record<string, TasksHandle>)[HANDLE_KEY] = handle;
}

/** Read the handle from pi.events; throws if tasks extension hasn't attached yet. */
export function getTasksHandle(pi: ExtensionAPI): TasksHandle {
  const handle = (pi.events as unknown as Record<string, TasksHandle | undefined>)[HANDLE_KEY];
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
