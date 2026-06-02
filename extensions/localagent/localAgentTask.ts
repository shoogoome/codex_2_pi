// LocalAgentTask — Task interface adapter for the framework.
//
// Why a singleton _pi binding instead of dependency injection?
//   The framework's `Task` interface (`kill(taskId, store)`) intentionally
//   does not pass `pi` — it is uniform across task types. LocalShellTask
//   uses the same pattern (B 期). The entrypoint binds `pi` once in
//   session_start and unbinds it in session_shutdown.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Task, TaskStoreLike } from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import { killLocalAgentTask } from "./kill.js";

let _currentPi: ExtensionAPI | undefined;

export function _bindPi(pi: ExtensionAPI): void {
  _currentPi = pi;
}

export function _unbindPi(): void {
  _currentPi = undefined;
}

export function _resetLocalAgentPiBindingForTest(): void {
  _currentPi = undefined;
}

export function _getPi(): ExtensionAPI {
  if (!_currentPi) {
    throw new Error(
      "LocalAgentTask called before extension session_start (pi not bound)",
    );
  }
  return _currentPi;
}

export const LocalAgentTask: Task = {
  name: "LocalAgentTask",
  type: "local_agent",
  async kill(taskId: string, store: TaskStoreLike): Promise<void> {
    await killLocalAgentTask(_getPi(), store as TaskStore, taskId);
  },
};
