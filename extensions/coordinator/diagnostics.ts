import type { TaskLedger } from "./taskLedger.js";
import type { Activity } from "./workerBridge.js";

export function diagnoseTasks(ledger: TaskLedger, activities: Map<string, Activity>, notify: (event: Record<string, unknown>) => void, now = Date.now()): void {
  for (const task of ledger.all()) for (const attempt of task.attempts) {
    const activity = activities.get(attempt.id);
    if (!activity || attempt.endedAt !== undefined) continue;
    const stalled = !activity.stallWarned && now - activity.last >= task.budgets.stallAfterMs;
    const duration = !activity.durationWarned && now - activity.started >= task.budgets.attemptWarnAfterMs;
    if (!stalled && !duration) continue;
    notify({ event: "diagnostic", logicalTaskId: task.id, executionTaskId: attempt.executionTaskId, stalled, duration, tool: activity.tool, toolDurationMs: activity.toolStarted ? now - activity.toolStarted : undefined, lastActivityAt: activity.last, elapsedMs: now - activity.started, note: "Observation only; not a deadlock verdict, cancellation or retry." });
    if (stalled) activity.stallWarned = true;
    if (duration) activity.durationWarned = true;
  }
}
