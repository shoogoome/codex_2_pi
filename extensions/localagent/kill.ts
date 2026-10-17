// killLocalAgentTask — sequence-sensitive shutdown of a LocalAgent task.
//
// Order matters (per Task 0 abort+dispose probe + Claude reference):
//   1. flip status → "killed" (so subsequent ticks see terminal state)
//   2. session.abort() — wait for SDK abort to settle
//   3. cleanup() — unsubscribe BEFORE dispose (or unsub may receive
//      events during dispose teardown)
//   4. session.dispose()
//   5. flushTaskOutput
//   6. notifyTaskTerminal — broadcast terminal status
//   7. removeProgress + evictTaskOutput

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../tasks/taskStore.js";
import { isTerminalTaskStatus } from "../tasks/Task.js";
import { updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput, flushTaskOutput } from "../tasks/diskOutput.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { emitTaskProgress } from "../tasks/progress.js";
import { logError } from "../tasks/logging.js";
import type { LocalAgentTaskState } from "./types.js";
import { getProgress, removeProgress } from "./progress.js";

export async function killLocalAgentTask(
  pi: ExtensionAPI,
  store: TaskStore,
  taskId: string,
): Promise<void> {
  const t = store.getTask(taskId) as LocalAgentTaskState | undefined;
  if (!t || isTerminalTaskStatus(t.status)) return;

  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
    ...cur,
    status: "killed",
    endTime: Date.now(),
  }));

  if (t.session) {
    try {
      await t.session.abort();
    } catch (e) {
      logError(e, "killLocalAgent abort");
    }
  }
  try {
    t.cleanup?.();
  } catch (e) {
    logError(e, "killLocalAgent cleanup");
  }
  try {
    t.session?.dispose();
  } catch (e) {
    logError(e, "killLocalAgent dispose");
  }
  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
    ...cur,
    session: undefined,
    cleanup: undefined,
  }));
  try {
    await flushTaskOutput(taskId);
  } catch (e) {
    logError(e, "killLocalAgent flush");
  }

  try {
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_agent",
      status: "killed",
      description: t.description,
      outputFile: t.outputFile,
      toolUseId: t.toolUseId,
      triggerTurn: true,
      extra: { agentType: t.agentType, ...getProgress(taskId) },
    });
  } catch (e) {
    logError(e, "killLocalAgent notify");
  }
  try {
    emitTaskProgress(pi, {
      taskId,
      taskType: "local_agent",
      kind: "kill",
      summary: "killed by user request",
      description: t.description,
      agentType: t.agentType,
    });
  } catch (e) {
    logError(e, "killLocalAgent progress");
  }
  // NOTE (terminal-summary removal): a `tasks/summary` customMessage used to
  // be emitted here. The task_agent tool's renderResult now owns the
  // user-visible "this task is done" line in the TUI, so the redundant
  // second main-stream row was dropped. Kill state still flows via
  // `tasks/notification` (jsonl + LLM context) above.
  removeProgress(taskId);
  try {
    await evictTaskOutput(taskId);
  } catch (e) {
    logError(e, "killLocalAgent evict output");
  }
}
