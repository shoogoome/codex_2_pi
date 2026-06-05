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
import { emitTaskSummary } from "../tasks/summary.js";
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
  try {
    await flushTaskOutput(taskId);
  } catch (e) {
    logError(e, "killLocalAgent flush");
  }

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
  emitTaskProgress(pi, {
    taskId,
    taskType: "local_agent",
    kind: "kill",
    summary: "killed by user request",
    description: t.description,
    agentType: t.agentType,
  });
  // Surface terminal status as a one-line summary in the main chat stream.
  // Kill is initiated externally so we don't have access to the spawn closure's
  // timeline here — emit with empty timeline (renderer falls back to head-only).
  const p = getProgress(taskId);
  emitTaskSummary(pi, {
    taskId,
    taskType: "local_agent",
    status: "killed",
    description: t.description,
    agentType: t.agentType,
    toolCallCount: p?.toolCallCount ?? 0,
    tokenCount: p?.tokenCount ?? 0,
    durationMs: t.startTime ? Date.now() - t.startTime : 0,
    timeline: [],
  });
  removeProgress(taskId);
  void evictTaskOutput(taskId);
}
