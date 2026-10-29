import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isForkWorker } from "../localagent/workerIdentity.js";
import { getTasksHandle } from "../tasks/handle.js";
import { applyCoordinatorPolicy } from "../shared/agentWorkflowPolicy.js";
import { getAgentMutationPause } from "../shared/agentMutationPause.js";
import { attachCoordinator, getWorkerBridge } from "./handle.js";
import { coordinatorCliValue, effectiveMode, parseMode, resolveMode, type ModeState } from "./mode.js";
import { TaskLedger, boundedText, type TaskInput, type TaskPatch } from "./taskLedger.js";
import { MessageRegistry } from "./messageRegistry.js";
import { createWorkerBridge, type Activity } from "./workerBridge.js";
import { diagnoseTasks } from "./diagnostics.js";

const StringList = Type.Array(Type.String());
const BudgetSchema = Type.Object({
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
  stallAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
  attemptWarnAfterMs: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const Contract = Type.Object({
  objective: Type.String({ minLength: 1 }), acceptance: StringList, nonGoals: StringList, writePaths: StringList,
  dependencies: Type.Optional(StringList), budgets: Type.Optional(BudgetSchema),
}, { additionalProperties: false });
const Patch = Type.Object({
  objective: Type.Optional(Type.String()), acceptance: Type.Optional(StringList), nonGoals: Type.Optional(StringList),
  writePaths: Type.Optional(StringList), dependencies: Type.Optional(StringList), budgets: Type.Optional(BudgetSchema),
  status: Type.Optional(Type.Union(["pending", "blocked", "awaiting_review", "accepted", "failed", "cancelled"].map(x => Type.Literal(x)))),
  decisionReason: Type.Optional(Type.String()), reviewEvidence: Type.Optional(Type.String()),
}, { additionalProperties: false });
const ReportParams = Type.Object({
  event_id: Type.String({ minLength: 1, maxLength: 200 }),
  event: Type.Union(["acknowledgement", "blocked", "scope_change", "interface_change", "checkpoint", "delivered", "failed"].map(x => Type.Literal(x))),
  payload: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
const bootKey = Symbol.for("pi.coordinator.initializedSessions.v1");
function bootSessions(): Set<string> {
  const host = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  return host[bootKey] ??= new Set();
}
function result(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: boundedText(JSON.stringify(value), 32000) }], details: value, ...(isError ? { isError: true } : {}) };
}

export default function coordinatorExtension(pi: ExtensionAPI): void {
  let mode: ModeState = { schemaVersion: 1, enabled: false, source: "default" };
  let context: ExtensionContext | undefined;
  let ready = false;
  let restoreError: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const activities = new Map<string, Activity>();
  const messages = new MessageRegistry();
  const ledger = new TaskLedger(task => pi.appendEntry("coordinator/task", task));
  const isWorker = (ctx: ExtensionContext) => Boolean(getWorkerBridge(pi) || isForkWorker(ctx.sessionManager.getSessionFile?.()));
  const effective = () => restoreError ? "paused-restore-error" : context ? effectiveMode(mode.enabled, pi.getActiveTools(), pi.getAllTools().map(x => x.name), Boolean(context.sessionManager.getSessionFile?.()), getAgentMutationPause().paused) : "off";
  const root = (ctx: ExtensionContext) => {
    if (isWorker(ctx)) throw new Error("Coordinator management belongs to the root session; workers report their own execution");
    if (!ready) throw new Error(restoreError ?? "Coordinator is not initialized");
  };
  const notify = (event: Record<string, unknown>) => pi.sendMessage({
    customType: "coordinator/event", content: boundedText(JSON.stringify(event), 6000), display: true, details: event,
  }, { triggerTurn: true });
  const updateUI = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("coordinator", mode.enabled ? "Coordinator · " + effective() : undefined);
  };
  const status = () => ({ desired: mode.enabled, effective: effective(), source: mode.source, error: restoreError });
  const startTimer = () => {
    if (timer) return;
    timer = setInterval(() => {
      if (!ready || effective() !== "active") return;
      try { diagnoseTasks(ledger, activities, notify); }
      catch (error) { context?.ui.notify("Coordinator diagnostic: " + String(error), "warning"); }
    }, 10000);
    timer.unref?.();
  };

  attachCoordinator(pi, {
    enabled: () => ready && mode.enabled,
    active: () => ready && effective() === "active",
    ledger,
    reserve(id, cwd) {
      if (!context) throw new Error("Coordinator has no root context");
      root(context);
      if (getAgentMutationPause().paused) throw new Error("Plan mode pauses managed dispatch");
      return createWorkerBridge({ ledger, messages, taskId: id, cwd, notify, activities });
    },
  });
  pi.registerFlag("coordinator", { type: "boolean", description: "Use the main session as coordinator; --coordinator=false disables (tools unchanged)" });
  pi.registerCommand("coordinator", {
    description: "Coordinator mode: on | off | status (default status; tools unchanged)",
    async handler(args, ctx) {
      if (isWorker(ctx)) { ctx.ui.notify("Coordinator command belongs to the root session", "error"); return; }
      const action = args.trim().toLowerCase() || "status";
      if (!["on", "off", "status"].includes(action)) { ctx.ui.notify("Usage: /coordinator [on|off|status]", "error"); return; }
      if (action !== "status") {
        root(ctx);
        mode = { schemaVersion: 1, enabled: action === "on", source: "command" };
        pi.appendEntry("coordinator/state", mode);
        updateUI(ctx);
      }
      pi.sendMessage({ customType: "coordinator/status", content: JSON.stringify(status()), display: true, details: status() });
    },
  });
  pi.registerTool({
    name: "coordinator_task", label: "Coordinator task",
    description: "Root logical task ledger: create complete outcome contracts; get/list; update with expected_revision. Delivery is awaiting_review; acceptance requires reviewEvidence. writePaths are concrete paths, not a write sandbox.",
    parameters: Type.Object({
      action: Type.Union(["create", "get", "list", "update"].map(x => Type.Literal(x))),
      task_id: Type.Optional(Type.String()), expected_revision: Type.Optional(Type.Integer()),
      contract: Type.Optional(Contract), patch: Type.Optional(Patch),
      section: Type.Optional(Type.Union([Type.Literal("task"), Type.Literal("attempts"), Type.Literal("reports"), Type.Literal("handoff")])),
      attempt_id: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        root(ctx);
        if (params.action === "list") return result(ledger.list(params.offset, params.limit).map(task => ledger.view(task.id)));
        if (params.action === "create") {
          if (!params.contract) throw new Error("contract is required");
          return result(ledger.create(ctx.cwd, params.contract as TaskInput));
        }
        if (!params.task_id) throw new Error("task_id is required");
        if (params.action === "get") {
          const task = ledger.get(params.task_id);
          const offset = params.offset ?? 0, limit = params.limit ?? 20;
          if (params.section === "handoff") return result({ targetVersion: task.targetVersion, handoffVersion: task.handoffVersion, handoffAttemptId: task.handoffAttemptId, handoff: task.handoff, verification: task.verification, evidenceMissing: task.evidenceMissing });
          if (params.section === "attempts") return result({ total: task.attempts.length, offset, items: task.attempts.slice(offset, offset + limit).map(({ reports, report, ...attempt }) => ({ ...attempt, reportCount: reports.length, report })) });
          if (params.section === "reports") {
            const attempt = task.attempts.find(a => a.id === params.attempt_id);
            if (!attempt) throw new Error("attempt_id is required for report history");
            return result({ total: attempt.reports.length, offset, items: attempt.reports.slice(offset, offset + limit) });
          }
          return result(ledger.view(params.task_id));
        }
        if (!params.patch || params.expected_revision === undefined) throw new Error("patch and expected_revision are required");
        return result(ledger.update(params.task_id, params.expected_revision, params.patch as TaskPatch));
      } catch (error) { return result({ error: String(error) }, true); }
    },
  });
  pi.registerTool({
    name: "localagent_message", label: "Message LocalAgent",
    description: "Send targeted steering to an owned running LocalAgent, or get a receipt. queued/entered/handled are not semantic acknowledgement or cancellation. No polling loops; terminal tasks cannot be revived.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("send"), Type.Literal("get")]),
      task_id: Type.String(), text: Type.Optional(Type.String({ maxLength: 12000 })),
      message_id: Type.Optional(Type.String({ maxLength: 200 })), target_version: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, params, _signal, _update, ctx) {
      try {
        root(ctx);
        if (params.action === "get") {
          if (!params.message_id) throw new Error("message_id is required");
          return result(messages.get(params.task_id, params.message_id));
        }
        const tasks = getTasksHandle(pi);
        const task = tasks.store.getTask(params.task_id);
        if (!task || task.type !== "local_agent" || task.status !== "running" || task.originSessionFile !== ctx.sessionManager.getSessionFile()) throw new Error("Not an owned running LocalAgent");
        const logical = ledger.all().find(t => t.attempts.some(a => a.executionTaskId === params.task_id && a.endedAt === undefined));
        if (logical && params.target_version !== undefined && params.target_version !== logical.targetVersion) throw new Error("Target version changed; read the task again");
        const control = tasks.conversations.control(params.task_id);
        if (!control) throw new Error("Task input is closed");
        return result(await messages.send(params.task_id, params.text ?? "", control, logical?.targetVersion, params.message_id));
      } catch (error) { return result({ error: String(error) }, true); }
    },
  });
  pi.registerTool({
    name: "localagent_report", label: "Report LocalAgent event",
    description: "Worker-bound report to root. Source identity comes from runtime, not arguments. acknowledgement needs messageId/targetVersion/direction/impact. blocked needs problem/evidence/tried/recommendation/modifiedFiles/verification/remaining; deliver needs modifiedFiles/acceptance/verification/risks. Report blocker then finish, never idle.",
    parameters: ReportParams,
    executionMode: "sequential",
    async execute(_id, params) {
      try {
        const bridge = getWorkerBridge(pi);
        if (!bridge) throw new Error("This call has no worker runtime binding");
        return result(bridge.report(params.event_id, params.event, params.payload));
      } catch (error) { return result({ error: String(error) }, true); }
    },
  });

  const restore = (ctx: ExtensionContext, initial: boolean) => {
    if (isWorker(ctx)) return;
    context = ctx;
    ready = false;
    try {
      let saved: ModeState | undefined;
      const branch = ctx.sessionManager.getBranch();
      for (const entry of branch) {
        if (entry.type !== "custom" || entry.customType !== "coordinator/state") continue;
        const data = entry.data as ModeState;
        if (data?.schemaVersion !== 1 || typeof data.enabled !== "boolean") throw new Error("Unsupported coordinator/state schemaVersion");
        saved = data;
      }
      const file = ctx.sessionManager.getSessionFile();
      const firstOpen = initial && !bootSessions().has(file ?? "no-session");
      const cli = firstOpen ? coordinatorCliValue(pi.getFlag("coordinator")) : undefined;
      const env = process.env.PI_COORDINATOR_MODE;
      if (env?.trim() && parseMode(env) === undefined) ctx.ui.notify("Invalid PI_COORDINATOR_MODE; ignored", "warning");
      mode = resolveMode(cli, saved, env);
      let live = new Set<string>();
      try { live = new Set(Object.values(getTasksHandle(pi).store.get()).filter(t => t.status === "running").map(t => t.id)); } catch { /* tools report missing dependency at use time */ }
      ledger.restore(branch, live, !initial);
      if (file) {
        if (firstOpen) pi.appendEntry("coordinator/state", mode);
        bootSessions().add(file);
      }
      restoreError = undefined;
      ready = true;
      startTimer();
      updateUI(ctx);
    } catch (error) {
      restoreError = String(error);
      ctx.ui.notify("Coordinator restore failed: " + restoreError, "error");
    }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx, true));
  pi.on("session_tree", (_event, ctx) => restore(ctx, false));
  pi.on("session_compact", (_event, ctx) => restore(ctx, false));
  pi.on("session_before_tree", (_event, ctx) => {
    if (isWorker(ctx)) return;
    if (ledger.all().some(task => ledger.active(task.id))) {
      ctx.ui.notify("Managed workers are still active. Wait for settlement or explicitly stop them before navigating the session tree.", "warning");
      return { cancel: true };
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (isWorker(ctx)) return { systemPrompt: applyCoordinatorPolicy(event.systemPrompt, { worker: true, enabled: false, effective: "off" }) };
    context = ctx;
    updateUI(ctx);
    return { systemPrompt: applyCoordinatorPolicy(event.systemPrompt, { enabled: ready && mode.enabled, effective: effective(), summary: ledger.summary() }) };
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (isWorker(ctx)) return;
    if (timer) clearInterval(timer);
    timer = undefined; ready = false;
    ledger.invalidate(); activities.clear(); messages.reset();
    if (ctx.hasUI) ctx.ui.setStatus("coordinator", undefined);
  });
}
