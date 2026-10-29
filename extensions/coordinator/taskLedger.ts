import { createHash, randomUUID } from "node:crypto";
import { normalizeWritePath, pathsOverlap } from "./pathOwnership.js";

export type LogicalStatus = "pending" | "running" | "blocked" | "awaiting_review" | "accepted" | "failed" | "cancelled";
export interface Budgets { maxAttempts: number; stallAfterMs: number; attemptWarnAfterMs: number }
export const DEFAULT_BUDGETS: Budgets = { maxAttempts: 3, stallAfterMs: 300000, attemptWarnAfterMs: 1800000 };
export interface Attempt {
  id: string;
  executionTaskId?: string;
  generation: number;
  assignedVersion: number;
  acknowledgedVersion: number;
  startedAt?: number;
  endedAt?: number;
  intent?: "blocked" | "delivered" | "failed";
  report?: Record<string, unknown>;
  reportVersion?: number;
  reports: Array<{ id: string; event: string; targetVersion: number; payload: Record<string, unknown>; fingerprint?: string; notificationError?: string }>;
}
export interface LogicalTask {
  schemaVersion: 1;
  id: string;
  revision: number;
  cwd: string;
  objective: string;
  acceptance: string[];
  nonGoals: string[];
  writePaths: string[];
  dependencies: string[];
  targetVersion: number;
  status: LogicalStatus;
  budgets: Budgets;
  attempts: Attempt[];
  decisions: string[];
  handoff?: Record<string, unknown>;
  handoffVersion?: number;
  handoffAttemptId?: string;
  verification?: unknown;
  reviewEvidence?: string;
  reason?: string;
  evidenceMissing?: boolean;
}
export interface TaskInput {
  objective: string; acceptance: string[]; nonGoals: string[]; writePaths: string[];
  dependencies?: string[]; budgets?: Partial<Budgets>;
}
export interface TaskPatch extends Partial<TaskInput> {
  status?: LogicalStatus; decisionReason?: string; reviewEvidence?: string;
}
export function boundedText(text: string, limit = 12000): string {
  return text.length <= limit ? text : text.slice(0, limit) + "\n[truncated]";
}
function boundedData<T>(value: T): T {
  if (typeof value === "string") return boundedText(value) as T;
  if (Array.isArray(value)) return value.map(boundedData) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k,v]) => [k, boundedData(v)])) as T;
  return value;
}
export function hasMeaningfulVerification(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    const absent = ["none", "n/a", "not run", "not_run", "not-run", "not tested", "not verified", "skipped", "未运行", "未执行", "未验证", "未测试"];
    return text.length > 0 && !absent.some(marker => text.startsWith(marker) && (text.length === marker.length || text.charAt(marker.length).trim() === "" || ":：,，".includes(text.charAt(marker.length))));
  }
  if (Array.isArray(value)) return value.some(hasMeaningfulVerification);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.status === "string" && !hasMeaningfulVerification(record.status)) return false;
    return Object.entries(record).some(([key, item]) => !["status", "passed", "success", "exitCode", "durationMs"].includes(key) && hasMeaningfulVerification(item));
  }
  return false;
}
export function reportFingerprint(event: string, version: number, payload: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify([event, version, canonical(payload)])).digest("hex");
}
function validate(input: TaskInput): void {
  const contract = { objective: input.objective, acceptance: input.acceptance, nonGoals: input.nonGoals, writePaths: input.writePaths, dependencies: input.dependencies, budgets: input.budgets };
  if (JSON.stringify(contract).length > 24000) throw new Error("Task contract exceeds 24000 characters; split it into focused outcomes");
  if (!input.objective?.trim() || !Array.isArray(input.acceptance) || !input.acceptance.length || input.acceptance.some(x => typeof x !== "string" || !x.trim())) throw new Error("objective and nonempty acceptance are required");
  if (!Array.isArray(input.nonGoals) || !Array.isArray(input.writePaths)) throw new Error("nonGoals and writePaths are required arrays (empty allowed)");
  for (const value of Object.values(input.budgets ?? {})) if (!Number.isSafeInteger(value) || value <= 0) throw new Error("budgets must be positive safe integers");
}
export class TaskLedger {
  private tasks = new Map<string, LogicalTask>();
  private reservations = new Map<string, { taskId: string; generation: number; version: number }>();
  generation = 0;
  constructor(private persist: (task: LogicalTask) => void) {}
  private save(task: LogicalTask): LogicalTask {
    const next = boundedData(structuredClone({ ...task, revision: task.revision + 1 }));
    this.persist(next); // Persistence failure must not publish partially committed state.
    this.tasks.set(next.id, next);
    return structuredClone(next);
  }
  get(id: string): LogicalTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error("Unknown logical task: " + id);
    return structuredClone(task);
  }
  view(id: string): Omit<LogicalTask, "attempts"> & { attemptCount: number; attempts: Array<Omit<Attempt, "reports" | "report">> } {
    const stored = this.tasks.get(id);
    if (!stored) throw new Error("Unknown logical task: " + id);
    const { attempts, ...task } = stored;
    return structuredClone({ ...task, attemptCount: attempts.length, attempts: attempts.slice(-10).map(({ reports: _reports, report: _report, ...attempt }) => attempt) });
  }
  contract(id: string): string {
    const task = this.view(id);
    return JSON.stringify({ ...task, decisions: task.decisions.slice(-10) });
  }
  list(offset = 0, limit = 20): LogicalTask[] { return [...this.tasks.values()].slice(Math.max(0, offset), Math.max(0, offset) + Math.min(100, Math.max(1, limit))).map(x => structuredClone(x)); }
  all(): LogicalTask[] { return [...this.tasks.values()].map(x => structuredClone(x)); }
  private dependencies(id: string, deps: string[]): void {
    const visit = (current: string, seen: Set<string>): void => {
      if (current === id) throw new Error("Cyclic task dependency");
      if (seen.has(current)) return;
      seen.add(current);
      for (const dependency of this.get(current).dependencies) visit(dependency, seen);
    };
    for (const dep of deps) visit(dep, new Set());
  }
  create(cwd: string, input: TaskInput): LogicalTask {
    validate(input);
    const id = "coord-" + randomUUID();
    this.dependencies(id, input.dependencies ?? []);
    return this.save({
      schemaVersion: 1, id, revision: 0, cwd,
      objective: input.objective, acceptance: input.acceptance, nonGoals: input.nonGoals,
      writePaths: input.writePaths.map(x => normalizeWritePath(cwd, x)),
      dependencies: input.dependencies ?? [], targetVersion: 1, status: "pending",
      budgets: { ...DEFAULT_BUDGETS, ...input.budgets }, attempts: [], decisions: [],
    });
  }
  update(id: string, revision: number, patch: TaskPatch): LogicalTask {
    const task = this.get(id);
    if (task.revision !== revision) throw new Error("Revision conflict; read the task again");
    validate({ ...task, ...patch, budgets: { ...task.budgets, ...patch.budgets } });
    const active = this.active(id);
    if (active && (patch.status || patch.writePaths || patch.dependencies)) throw new Error("Execution still active; wait for actual settlement before transferring responsibility");
    if (patch.budgets && !patch.decisionReason?.trim()) throw new Error("Budget updates require decisionReason");
    if (patch.status === "running") throw new Error("Only a successfully started execution can mark running");
    if (patch.status === "accepted" && (task.status !== "awaiting_review" || !patch.reviewEvidence?.trim())) throw new Error("Acceptance requires awaiting_review and reviewEvidence");
    this.dependencies(id, patch.dependencies ?? task.dependencies);
    const changedGoal = patch.objective !== undefined || patch.acceptance !== undefined || patch.nonGoals !== undefined;
    const { decisionReason, ...fields } = patch;
    return this.save({
      ...task, ...fields,
      writePaths: patch.writePaths?.map(x => normalizeWritePath(task.cwd, x)) ?? task.writePaths,
      budgets: { ...task.budgets, ...patch.budgets },
      targetVersion: task.targetVersion + (changedGoal ? 1 : 0),
      status: changedGoal && !active ? "pending" : patch.status ?? task.status,
      reviewEvidence: changedGoal ? undefined : patch.reviewEvidence ?? task.reviewEvidence,
      evidenceMissing: changedGoal ? true : task.evidenceMissing,
      decisions: decisionReason ? [...task.decisions, decisionReason] : task.decisions,
    });
  }
  active(id: string): boolean {
    return [...this.reservations.values()].some(x => x.taskId === id) || this.get(id).attempts.some(a => a.startedAt !== undefined && a.endedAt === undefined);
  }
  reserve(id: string): string {
    const task = this.get(id);
    if (task.status !== "pending") throw new Error("Task must be pending before dispatch");
    if (this.active(id)) throw new Error("Task already has an active execution");
    if (task.attempts.filter(a => a.startedAt !== undefined).length >= task.budgets.maxAttempts) throw new Error("Attempt budget exhausted; explicitly revise the budget with a reason");
    for (const dependency of task.dependencies) if (this.get(dependency).status !== "accepted") throw new Error("Dependency not accepted: " + dependency);
    for (const other of this.all()) {
      if (other.id === id || !this.active(other.id)) continue;
      if (task.writePaths.some(p => other.writePaths.some(q => pathsOverlap(p, q)))) throw new Error("Write responsibility conflicts with task " + other.id);
    }
    const token = randomUUID();
    this.reservations.set(token, { taskId: id, generation: this.generation, version: task.targetVersion });
    return token;
  }
  releaseReservation(token: string): void { this.reservations.delete(token); }
  start(token: string, executionTaskId: string): Attempt {
    const reservation = this.reservations.get(token);
    if (!reservation || reservation.generation !== this.generation) throw new Error("Dispatch reservation expired");
    const task = this.get(reservation.taskId);
    if (task.targetVersion !== reservation.version) throw new Error("Task changed during dispatch");
    const attempt: Attempt = { id: token, executionTaskId, generation: this.generation, assignedVersion: task.targetVersion, acknowledgedVersion: task.targetVersion, startedAt: Date.now(), reports: [] };
    this.save({ ...task, status: "running", attempts: [...task.attempts, attempt], reason: undefined });
    this.reservations.delete(token);
    return attempt;
  }
  attempt(taskId: string, attemptId: string): { task: LogicalTask; attempt: Attempt } {
    const task = this.get(taskId);
    const attempt = task.attempts.find(a => a.id === attemptId);
    if (!attempt || attempt.generation !== this.generation || attempt.endedAt !== undefined) throw new Error("Stale or terminal worker attempt");
    return { task, attempt };
  }
  report(taskId: string, attemptId: string, eventId: string, event: string, version: number, payload: Record<string, unknown>, acknowledged = false): LogicalTask {
    const { task, attempt } = this.attempt(taskId, attemptId);
    const fingerprint = reportFingerprint(event, version, payload);
    const previous = attempt.reports.find(r => r.id === eventId);
    if (previous) {
      if ((previous.fingerprint ?? reportFingerprint(previous.event, previous.targetVersion, previous.payload)) !== fingerprint) throw new Error("Conflicting report retry");
      return task;
    }
    if (acknowledged) attempt.acknowledgedVersion = version;
    if (attempt.reports.length >= 256) throw new Error("Attempt report limit reached; finish and hand off instead of sending unbounded events");
    attempt.reports.push({ id: eventId, event, targetVersion: version, payload: boundedData(payload), fingerprint });
    if (version === task.targetVersion && attempt.acknowledgedVersion === version) {
      if (["blocked", "delivered", "failed"].includes(event)) {
        attempt.intent = event as Attempt["intent"];
        attempt.report = boundedData(payload);
        attempt.reportVersion = version;
        task.handoff = attempt.report;
        task.handoffVersion = version;
        task.handoffAttemptId = attempt.id;
        task.verification = payload.verification;
      }
    }
    return this.save(task);
  }
  notification(taskId: string, attemptId: string, eventId: string, error?: string): void {
    const { task, attempt } = this.attempt(taskId, attemptId);
    const event = attempt.reports.find(r => r.id === eventId);
    if (!event) throw new Error("Unknown report event");
    event.notificationError = error;
    this.save(task);
  }
  finish(taskId: string, attemptId: string, status: "completed" | "failed" | "killed"): LogicalTask {
    const { task, attempt } = this.attempt(taskId, attemptId);
    attempt.endedAt = Date.now();
    const outdated = attempt.acknowledgedVersion !== task.targetVersion;
    const currentReport = attempt.reportVersion === task.targetVersion;
    const staleDelivery = attempt.intent === "delivered" && !currentReport;
    task.status = status === "killed" ? "cancelled" : status === "failed" || (currentReport && attempt.intent === "failed") ? "failed" : outdated || staleDelivery || (currentReport && attempt.intent === "blocked") ? "blocked" : "awaiting_review";
    task.reason = outdated ? "outdated-direction" : staleDelivery ? "delivery-version-outdated" : currentReport ? attempt.intent : undefined;
    task.evidenceMissing = !currentReport || attempt.intent !== "delivered" || !hasMeaningfulVerification(attempt.report?.verification);
    return this.save(task);
  }
  restore(entries: Iterable<unknown>, liveExecutionIds: ReadonlySet<string> = new Set(), preserveReservations = false): void {
    const restored = new Map<string, LogicalTask>();
    for (const entry of entries) {
      const e = entry as { type?: string; customType?: string; data?: LogicalTask };
      if (e.type !== "custom" || e.customType !== "coordinator/task") continue;
      if (e.data?.schemaVersion !== 1) throw new Error("Unsupported coordinator/task schemaVersion");
      restored.set(e.data.id, structuredClone(e.data));
    }
    this.tasks = restored;
    if (!preserveReservations) this.reservations.clear();
    for (const task of this.all()) {
      for (const attempt of task.attempts) {
        if (attempt.endedAt === undefined && attempt.executionTaskId && !liveExecutionIds.has(attempt.executionTaskId)) {
          attempt.endedAt = Date.now();
          task.status = "blocked";
          task.reason = "interrupted";
        }
      }
      if (task.reason === "interrupted") this.save(task);
    }
  }
  invalidate(): void { this.generation++; this.reservations.clear(); }
  summary(): string { return boundedText([...this.tasks.values()].slice(0, 30).map(t => t.id + " " + t.status + " v" + t.targetVersion + ": " + t.objective).join("\n"), 6000); }
}
