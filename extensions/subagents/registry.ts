import type {
  CreateEntryInput,
  SubagentEntry,
  SubagentInternalEvent,
  SubagentRuntimeOptions,
  SubagentSummary,
  SubagentTurnStatus,
  WaitResult,
} from "./types.js";
import { buildAssistantPreview, createDefaultUsage, previewText } from "./text.js";

interface Waiter {
  target: string | undefined;
  sinceVersion: number;
  resolve: (result: WaitResult) => void;
  timer: NodeJS.Timeout;
}

export class SubagentRegistry {
  private readonly entries = new Map<string, SubagentEntry>();
  private readonly idsByTaskName = new Map<string, string>();
  private readonly waiters = new Set<Waiter>();
  private nextId = 1;

  constructor(private readonly options: SubagentRuntimeOptions) {}

  createEntry(input: CreateEntryInput): SubagentEntry {
    if (this.entries.size >= this.options.maxAgents) {
      throw new Error(`subagent limit reached: ${this.options.maxAgents}`);
    }
    if (this.idsByTaskName.has(input.taskName)) {
      throw new Error(`subagent task_name already exists: ${input.taskName}`);
    }

    const now = Date.now();
    const id = `agent_${this.nextId++}`;
    const entry: SubagentEntry = {
      id,
      taskName: input.taskName,
      cwd: input.cwd,
      status: "starting",
      lastTurnStatus: "none",
      startedAt: now,
      updatedAt: now,
      stderrTail: "",
      usage: createDefaultUsage(),
      events: [],
      mailboxVersion: 0,
      intentionallyClosed: false,
    };

    this.entries.set(id, entry);
    this.idsByTaskName.set(input.taskName, id);
    this.notify(entry);
    return entry;
  }

  list(): SubagentSummary[] {
    return Array.from(this.entries.values()).map((entry) => this.toSummary(entry));
  }

  resolve(target: string): SubagentEntry | undefined {
    return this.entries.get(target) ?? this.entries.get(this.idsByTaskName.get(target) ?? "");
  }

  markRunning(id: string): void {
    const entry = this.requireEntry(id);
    entry.status = "running";
    this.touch(entry);
  }

  markIdle(id: string, lastTurnStatus: SubagentTurnStatus): void {
    const entry = this.requireEntry(id);
    entry.status = "idle";
    entry.lastTurnStatus = lastTurnStatus;
    if (lastTurnStatus === "completed") entry.usage.turns += 1;
    this.touch(entry);
  }

  markFailed(id: string, message: string): void {
    const entry = this.requireEntry(id);
    entry.status = "failed";
    entry.lastTurnStatus = "failed";
    entry.lastError = previewText(message, 500);
    entry.endedAt = Date.now();
    this.touch(entry);
  }

  markClosed(id: string): void {
    const entry = this.requireEntry(id);
    entry.status = "closed";
    entry.intentionallyClosed = true;
    entry.endedAt = Date.now();
    this.touch(entry);
  }

  updateAssistantMessage(id: string, text: string): void {
    const entry = this.requireEntry(id);
    entry.lastAssistantMessage = text;
    this.touch(entry);
  }

  updateUsage(id: string, usage: Partial<SubagentEntry["usage"]>): void {
    const entry = this.requireEntry(id);
    entry.usage = {
      turns: entry.usage.turns,
      input: entry.usage.input + Math.max(0, usage.input ?? 0),
      output: entry.usage.output + Math.max(0, usage.output ?? 0),
      cacheRead: entry.usage.cacheRead + Math.max(0, usage.cacheRead ?? 0),
      cacheWrite: entry.usage.cacheWrite + Math.max(0, usage.cacheWrite ?? 0),
      cost: entry.usage.cost + Math.max(0, usage.cost ?? 0),
    };
    this.touch(entry);
  }

  appendStderr(id: string, text: string): void {
    const entry = this.requireEntry(id);
    entry.stderrTail = previewText(`${entry.stderrTail}\n${text}`, 2_000);
    this.recordEvent(id, { kind: "stderr", timestamp: Date.now(), summary: previewText(text, 240), isError: true });
  }

  recordEvent(id: string, event: SubagentInternalEvent): void {
    const entry = this.requireEntry(id);
    entry.events.push(event);
    if (entry.events.length > this.options.maxEventLogEntries) {
      entry.events.splice(0, entry.events.length - this.options.maxEventLogEntries);
    }
    this.touch(entry);
  }

  waitForUpdate(target: string | undefined, timeoutMs: number): Promise<WaitResult> {
    const sinceVersion = this.maxMailboxVersion(target);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        target,
        sinceVersion,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve({ timedOut: true, agents: this.summariesForTarget(target) });
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      this.flushWaiter(waiter);
    });
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.intentionallyClosed = true;
      entry.process?.kill("SIGTERM");
      entry.status = "closed";
      entry.endedAt = Date.now();
      this.touch(entry);
    }
  }

  private requireEntry(id: string): SubagentEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`subagent not found: ${id}`);
    return entry;
  }

  private touch(entry: SubagentEntry): void {
    entry.updatedAt = Date.now();
    entry.mailboxVersion += 1;
    this.notify(entry);
  }

  private notify(_entry: SubagentEntry): void {
    for (const waiter of Array.from(this.waiters)) this.flushWaiter(waiter);
  }

  private flushWaiter(waiter: Waiter): void {
    if (this.maxMailboxVersion(waiter.target) <= waiter.sinceVersion) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(waiter);
    waiter.resolve({ timedOut: false, agents: this.summariesForTarget(waiter.target) });
  }

  private maxMailboxVersion(target: string | undefined): number {
    const entries = target ? [this.resolve(target)].filter((entry): entry is SubagentEntry => Boolean(entry)) : Array.from(this.entries.values());
    return entries.reduce((max, entry) => Math.max(max, entry.mailboxVersion), 0);
  }

  private summariesForTarget(target: string | undefined): SubagentSummary[] {
    const entries = target ? [this.resolve(target)].filter((entry): entry is SubagentEntry => Boolean(entry)) : Array.from(this.entries.values());
    return entries.map((entry) => this.toSummary(entry));
  }

  private toSummary(entry: SubagentEntry): SubagentSummary {
    return {
      id: entry.id,
      taskName: entry.taskName,
      cwd: entry.cwd,
      status: entry.status,
      lastTurnStatus: entry.lastTurnStatus,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      endedAt: entry.endedAt,
      lastAssistantPreview: buildAssistantPreview(entry.lastAssistantMessage),
      lastError: entry.lastError,
      stderrPreview: buildAssistantPreview(entry.stderrTail),
      usage: { ...entry.usage },
      eventCount: entry.events.length,
      recentEvents: [...entry.events],
      mailboxVersion: entry.mailboxVersion,
    };
  }
}
