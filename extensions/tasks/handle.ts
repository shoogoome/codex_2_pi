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

const HANDLE_KEY = "__pi_tasks_handle__";

export interface TasksHandle {
  store: TaskStore;
  registerTaskType(type: TaskType, task: Task): void;
  getTaskType(type: TaskType): Task | undefined;
  unregisterTaskType(type: TaskType): void;
}

/** Publish the handle so cross-extension consumers can find it. */
export function attachTasksHandle(pi: ExtensionAPI, handle: TasksHandle): void {
  attachSessionHandle(pi, HANDLE_KEY, handle);
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
