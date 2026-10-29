import { randomUUID } from "node:crypto";
import type { ConversationControl, ConversationSubmission } from "../tasks/agentConversations.js";

export interface MessageRecord extends ConversationSubmission {
  taskId: string;
  targetVersion?: number;
  accepted?: boolean;
  acknowledged?: string;
  terminal?: boolean;
}
export class MessageRegistry {
  private records = new Map<string, MessageRecord>();
  private generation = 0;
  private inFlight = new Map<string, Promise<MessageRecord>>();
  constructor(private limit = 256) {}
  get(taskId: string, id: string): MessageRecord {
    const record = this.records.get(id);
    if (!record || record.taskId !== taskId) throw new Error("Unknown message for this execution");
    return { ...record };
  }
  acknowledge(taskId: string, id: string, version: number, text: string): void {
    const record = this.get(taskId, id);
    if (record.status !== "entered" || record.targetVersion !== version) throw new Error("Message has not entered this worker/version");
    this.records.set(id, { ...record, acknowledged: text });
  }
  send(taskId: string, text: string, control: ConversationControl, version?: number, retryId?: string): Promise<MessageRecord> {
    const id = retryId ?? taskId + ":coord-" + randomUUID();
    const existing = this.records.get(id);
    if (existing) {
      if (existing.taskId !== taskId || existing.text !== text || existing.targetVersion !== version) throw new Error("Message retry identity conflicts with its original input");
      return this.inFlight.get(id) ?? Promise.resolve(this.get(taskId, id));
    }
    if (!text.trim() || text.trim().startsWith("/")) throw new Error("A nonempty natural-language message is required");
    while (this.records.size >= this.limit) {
      const removable = [...this.records].find(([key, r]) => !this.inFlight.has(key) && (r.terminal || ["handled", "failed", "cancelled"].includes(r.status)));
      if (!removable) throw new Error("Message registry capacity reached; complete or cancel pending messages");
      this.records.delete(removable[0]);
    }
    const generation = this.generation;
    const cancelled = (): MessageRecord => ({ id, taskId, text, status: "cancelled", accepted: false, error: "Root session replaced", targetVersion: version });
    this.records.set(id, { id, taskId, text, status: "submitting", targetVersion: version });
    const operation = control.submit(text, {
      messageId: id, targetVersion: version,
      onStatus: submission => {
        const old = this.records.get(id);
        if (old && generation === this.generation) this.records.set(id, { ...old, ...submission });
      },
    }).then(result => {
      if (generation !== this.generation) return cancelled();
      const record = this.records.get(id)!;
      this.records.set(id, { ...record, accepted: result.accepted, ...(result.error ? { status: "failed", error: result.error } : {}) });
      return this.get(taskId, id);
    }).catch(error => {
      if (generation !== this.generation) return cancelled();
      const record = this.records.get(id)!;
      this.records.set(id, { ...record, accepted: false, status: "failed", error: String(error) });
      return this.get(taskId, id);
    }).finally(() => { if (generation === this.generation) this.inFlight.delete(id); });
    this.inFlight.set(id, operation);
    return operation;
  }
  finish(taskId: string): void {
    for (const [id, record] of this.records) if (record.taskId === taskId) this.records.set(id, { ...record, terminal: true, ...(["submitting", "queued"].includes(record.status) ? { status: "cancelled" as const } : {}) });
  }
  reset(): void { this.generation++; this.records.clear(); this.inFlight.clear(); }
}
