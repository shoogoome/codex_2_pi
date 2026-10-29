import type { TaskStatus } from "./Task.js";
import { logError } from "./logging.js";

export type SubmissionStatus = "submitting" | "queued" | "entered" | "handled" | "failed" | "cancelled";
export interface ConversationSubmission {
  id: string;
  text: string;
  status: SubmissionStatus;
  error?: string;
}
export interface ConversationMessage {
  kind: "message";
  id: string;
  revision: number;
  streaming: boolean;
  message: { role: "user" | "assistant"; content: unknown; [key: string]: unknown };
}
export interface ConversationTool {
  kind: "tool";
  id: string;
  revision: number;
  name: string;
  parentId?: string;
  args: unknown;
  started: boolean;
  complete: boolean;
  result?: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean };
}
export type ConversationEntry = ConversationMessage | ConversationTool;
export interface AgentConversation {
  id: string;
  generation: number;
  description: string;
  cwd: string;
  startTime: number;
  endTime?: number;
  status: TaskStatus;
  revision: number;
  entries: ConversationEntry[];
  submissions: ConversationSubmission[];
  truncated: boolean;
  bytes: number;
}
export interface ConversationReadingState {
  draft: string;
  expanded: boolean;
  hideThinking: boolean;
  follow: boolean;
  top: number;
  initialized?: boolean;
}
export interface SubmissionMetadata {
  messageId: string;
  targetVersion?: number;
  onStatus?(submission: ConversationSubmission): void;
}
export interface ConversationControl {
  submit(text: string, metadata?: SubmissionMetadata): Promise<{ accepted: boolean; error?: string; submissionId?: string }>;
  close(reason: string): void;
  getToolRenderers?(name: string): unknown;
}
export interface AgentConversations {
  readonly generation: number;
  begin(meta: Pick<AgentConversation, "id" | "description" | "cwd" | "startTime">, prompt: string): number;
  get(id: string): AgentConversation | undefined;
  list(): AgentConversation[];
  put(id: string, generation: number, entry: ConversationEntry): void;
  submission(id: string, generation: number, submission: ConversationSubmission): void;
  finish(id: string, generation: number, status: TaskStatus): void;
  registerControl(id: string, generation: number, control: ConversationControl): () => void;
  control(id: string): ConversationControl | undefined;
  reading(id: string): ConversationReadingState;
  pin(id: string): () => void;
  subscribe(listener: (id: string) => void): () => void;
  reset(): void;
}

const TRUNCATED = "[展示记录已截断 / display record truncated]";
const DEFAULT_LIMITS = { taskBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, completed: 20 };

/** Copy display data only. Never retain arbitrary SDK objects, closures or signatures. */
export function copyDisplayData(value: unknown, maxBytes = DEFAULT_LIMITS.taskBytes): unknown {
  let remaining = Math.max(0, maxBytes);
  const seen = new WeakSet<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") {
      if (remaining <= 0) return TRUNCATED;
      const candidate = v.slice(0, remaining);
      const bytes = Buffer.byteLength(candidate);
      if (bytes <= remaining && candidate.length === v.length) { remaining -= bytes; return candidate; }
      const clipped = Buffer.from(candidate).subarray(0, remaining).toString("utf8");
      remaining = 0;
      return clipped + TRUNCATED;
    }
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (!v || typeof v !== "object") return undefined;
    if (depth > 24 || remaining <= 0 || seen.has(v)) return TRUNCATED;
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return "[non-display object omitted]";
    seen.add(v);
    remaining -= 8;
    if (Array.isArray(v)) {
      const result = v.slice(0, 4096).map((item) => visit(item, depth + 1));
      if (v.length > 4096) result.push(TRUNCATED);
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(v).slice(0, 4096)) {
      if (/signature$|^(authorization|access_token|refresh_token)$/i.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) continue;
      remaining -= Buffer.byteLength(key) + 4;
      const copied = visit((v as Record<string, unknown>)[key], depth + 1);
      if (copied !== undefined) result[key] = copied;
      if (remaining <= 0) { result.displayTruncated = true; break; }
    }
    return result;
  };
  return visit(value, 0);
}

export function createAgentConversations(limits: Partial<typeof DEFAULT_LIMITS> = {}): AgentConversations {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  const records = new Map<string, AgentConversation>();
  const indexes = new Map<string, Map<string, number>>();
  const sizes = new WeakMap<object, number>();
  const controls = new Map<string, ConversationControl>();
  const readings = new Map<string, ConversationReadingState>();
  const pins = new Map<string, number>();
  const listeners = new Set<(id: string) => void>();
  let generation = 0;
  let totalBytes = 0;
  const size = (value: object): number => sizes.get(value) ?? 0;
  const measure = (value: object): number => {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    sizes.set(value, bytes);
    return bytes;
  };
  const notify = (id: string): void => {
    for (const listener of [...listeners]) {
      try { listener(id); } catch (error) { logError(error, "agent conversation listener"); }
    }
  };
  const remove = (r: AgentConversation): void => {
    totalBytes -= r.bytes;
    records.delete(r.id); indexes.delete(r.id); readings.delete(r.id); pins.delete(r.id);
    notify(r.id);
  };
  const reindex = (r: AgentConversation): void => {
    indexes.set(r.id, new Map(r.entries.map((e, i) => [e.id, i])));
  };
  const trimOne = (r: AgentConversation): boolean => {
    const entry = r.entries.shift();
    const submission = !entry ? r.submissions.shift() : undefined;
    const removed = entry ?? submission;
    if (!removed) return false;
    const bytes = size(removed);
    r.bytes -= bytes; totalBytes -= bytes;
    r.truncated = true; r.revision++;
    reindex(r);
    return true;
  };
  const enforce = (): void => {
    const terminal = [...records.values()].filter((r) => r.status !== "running");
    while (terminal.length > cap.completed) {
      const i = terminal.findIndex((r) => !pins.has(r.id));
      if (i < 0) break;
      remove(terminal.splice(i, 1)[0]!);
    }
    for (const r of records.values()) while (r.bytes > cap.taskBytes && trimOne(r)) { /* bounded */ }
    while (totalBytes > cap.totalBytes) {
      const removable = [...records.values()].find((r) => r.status !== "running" && !pins.has(r.id));
      if (removable) { remove(removable); continue; }
      const r = [...records.values()].find((item) => item.entries.length || item.submissions.length);
      if (!r || !trimOne(r)) break;
      notify(r.id);
    }
  };
  const current = (id: string, gen: number): AgentConversation | undefined => {
    const r = records.get(id);
    return gen === generation && r?.generation === gen ? r : undefined;
  };
  const api: AgentConversations = {
    get generation() { return generation; },
    begin(meta, prompt) {
      const r: AgentConversation = { ...meta, generation, status: "running", revision: 0, entries: [], submissions: [], truncated: false, bytes: 0 };
      records.set(meta.id, r); indexes.set(meta.id, new Map());
      api.put(meta.id, generation, { kind: "message", id: "delegation", revision: 0, streaming: false, message: { role: "user", content: prompt } });
      return generation;
    },
    get: (id) => records.get(id),
    list: () => [...records.values()],
    put(id, gen, entry) {
      const r = current(id, gen);
      if (!r || r.status !== "running") return;
      const copied = copyDisplayData(entry, cap.taskBytes) as ConversationEntry;
      // The stable identity is local metadata, not part of the limited payload.
      copied.id = entry.id; copied.kind = entry.kind;
      const idx = indexes.get(id)!;
      const at = idx.get(entry.id);
      const old = at === undefined ? undefined : r.entries[at];
      copied.revision = (old?.revision ?? 0) + 1;
      const delta = measure(copied) - (old ? size(old) : 0);
      if (JSON.stringify(copied).includes(TRUNCATED) || JSON.stringify(copied).includes('"displayTruncated":true')) r.truncated = true;
      r.bytes += delta; totalBytes += delta;
      if (at === undefined) { idx.set(entry.id, r.entries.length); r.entries.push(copied); }
      else r.entries[at] = copied;
      r.revision++; enforce(); notify(id);
    },
    submission(id, gen, submission) {
      const r = current(id, gen);
      if (!r) return;
      const copied = copyDisplayData(submission, cap.taskBytes) as ConversationSubmission;
      copied.id = submission.id; copied.status = submission.status;
      const at = r.submissions.findIndex((s) => s.id === submission.id);
      const old = r.submissions[at];
      const delta = measure(copied) - (old ? size(old) : 0);
      r.bytes += delta; totalBytes += delta;
      if (at < 0) r.submissions.push(copied); else r.submissions[at] = copied;
      r.revision++; enforce(); notify(id);
    },
    finish(id, gen, status) {
      const r = current(id, gen);
      if (!r || r.status !== "running") return;
      controls.delete(id);
      r.status = status; r.endTime = Date.now(); r.revision++;
      enforce(); notify(id);
    },
    registerControl(id, gen, control) {
      if (current(id, gen)?.status !== "running") return () => {};
      controls.set(id, control);
      return () => { if (controls.get(id) === control) controls.delete(id); };
    },
    control: (id) => controls.get(id),
    reading(id) {
      let state = readings.get(id);
      if (!state) { state = { draft: "", expanded: false, hideThinking: false, follow: true, top: 0 }; readings.set(id, state); }
      return state;
    },
    pin(id) {
      const gen = generation;
      pins.set(id, (pins.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released || gen !== generation) return;
        released = true;
        const n = (pins.get(id) ?? 1) - 1;
        if (n > 0) pins.set(id, n); else pins.delete(id);
        enforce();
      };
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset() {
      generation++;
      for (const control of controls.values()) { try { control.close("Root session replaced"); } catch (error) { logError(error, "conversation reset"); } }
      controls.clear(); records.clear(); indexes.clear(); readings.clear(); pins.clear(); totalBytes = 0;
      notify("");
    },
  };
  return api;
}
