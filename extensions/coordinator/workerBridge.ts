import type { WorkerBridge } from "./handle.js";
import { TaskLedger, boundedText, reportFingerprint } from "./taskLedger.js";
import type { MessageRegistry } from "./messageRegistry.js";

export interface Activity { last: number; started: number; tool?: string; toolStarted?: number; stallWarned: boolean; durationWarned: boolean }
export function createWorkerBridge(options: {
  ledger: TaskLedger; messages: MessageRegistry; taskId: string; cwd: string;
  notify(event: Record<string, unknown>): void;
  activities: Map<string, Activity>;
}): WorkerBridge {
  const { ledger, taskId } = options;
  const task = ledger.get(taskId);
  if (task.cwd !== options.cwd) throw new Error("Dispatch cwd must match the logical task cwd");
  const token = ledger.reserve(taskId);
  const generation = ledger.generation;
  let executionId: string | undefined;
  let finished: Record<string, unknown> | undefined;
  const notifications = new Map<string, boolean>();
  const current = () => {
    if (ledger.generation !== generation) throw new Error("Root session was replaced");
    return ledger.attempt(taskId, token);
  };
  return {
    logicalTaskId: taskId,
    prompt: [
      "You are the leaf executor of this logical task. Use tools directly, not coordinator duties.",
      "Contract and prior handoff (current source of truth):", ledger.contract(taskId),
      "Report with localagent_report: acknowledgement, blocked, scope_change, interface_change, checkpoint, delivered or failed. Include targetVersion.",
      "For blocked include problem, evidence, tried, recommendation, modifiedFiles, verification, remaining; then finish safely, do not idle.",
      "For delivered include modifiedFiles, acceptance, verification (actual commands/results), risks. Delivery is not acceptance.",
      "For coordinator_message explicitly acknowledge messageId and targetVersion with direction and impact. Queued/entered are not semantic acknowledgement.",
    ].join("\n"),
    start(id) {
      ledger.start(token, id);
      executionId = id;
      const now = Date.now();
      options.activities.set(token, { started: now, last: now, stallWarned: false, durationWarned: false });
    },
    report(eventId, event, payload) {
      if (JSON.stringify(payload).length > 24000) throw new Error("Report exceeds 24000 characters; report a focused handoff and reference output files");
      const { task: latest, attempt } = current();
      if (!executionId) throw new Error("Execution has not started");
      const version = typeof payload.targetVersion === "number" ? payload.targetVersion : attempt.acknowledgedVersion;
      const previous = attempt.reports.find(r => r.id === eventId);
      if (previous && (previous.fingerprint ?? reportFingerprint(previous.event, previous.targetVersion, previous.payload)) !== reportFingerprint(event, version, payload)) throw new Error("Conflicting report retry");
      const ack = event === "acknowledgement";
      if (ack && !previous) {
        if (version !== latest.targetVersion || typeof payload.messageId !== "string" || typeof payload.direction !== "string" || typeof payload.impact !== "string") throw new Error("Acknowledgement requires current targetVersion, messageId, direction and impact");
        options.messages.acknowledge(executionId, payload.messageId, version, payload.direction + "\n" + payload.impact);
      }
      if (event === "blocked") {
        for (const key of ["problem", "evidence", "tried", "recommendation", "modifiedFiles", "verification", "remaining"]) if (!(key in payload)) throw new Error("Blocked handoff missing " + key);
      }
      if (event === "delivered") {
        for (const key of ["modifiedFiles", "acceptance", "verification", "risks"]) if (!(key in payload)) throw new Error("Delivery missing " + key);
      }
      ledger.report(taskId, token, eventId, event, version, payload, ack);
      const wake = ["blocked", "scope_change", "interface_change", "failed"].includes(event) || (event === "checkpoint" && payload.requiresAction === true);
      if (!wake || notifications.get(eventId)) return { saved: true };
      try {
        options.notify({ logicalTaskId: taskId, executionTaskId: executionId, eventId, event, targetVersion: version, summary: boundedText(JSON.stringify(payload), 4000) });
        notifications.set(eventId, true);
        if (previous?.notificationError) ledger.notification(taskId, token, eventId);
        return { saved: true };
      } catch (error) {
        let notificationError = String(error);
        try { ledger.notification(taskId, token, eventId, notificationError); }
        catch (persistenceError) { notificationError += "; could not persist notification status: " + String(persistenceError); }
        return { saved: true, notificationError };
      }
    },
    finish(status) {
      if (finished) return finished;
      try {
        current();
        const result = ledger.finish(taskId, token, status);
        finished = { logicalTaskId: taskId, attemptId: token, targetVersion: result.targetVersion, logicalStatus: result.status, handoff: result.handoffVersion === result.targetVersion && result.handoffAttemptId === token ? result.handoff : undefined, handoffVersion: result.handoffVersion, evidenceMissing: result.evidenceMissing };
        return finished;
      } finally {
        options.activities.delete(token);
        if (executionId) options.messages.finish(executionId);
      }
    },
    rollback() { ledger.releaseReservation(token); },
    activity(type, tool) {
      const state = options.activities.get(token);
      if (!state || generation !== ledger.generation) return;
      state.last = Date.now(); state.stallWarned = false;
      if (type === "tool_execution_start") { state.tool = tool; state.toolStarted = state.last; }
      if (type === "tool_execution_end") { state.tool = undefined; state.toolStarted = undefined; }
    },
  };
}
