import {
  MAX_STORED_SUMMARIES,
  SUMMARY_CUSTOM_ENTRY,
  SUMMARY_EVENT_VERSION,
  type BranchEntryLike,
  type PersistedSessionSummaryEntry,
  type SessionSummaryEntry,
  type SessionSummaryEvent,
  type SessionSummaryState,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOneLine(text: string, maxChars = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function parsePersistedEntry(value: unknown): PersistedSessionSummaryEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (value.role !== "user" && value.role !== "agent") return undefined;
  if (typeof value.summary !== "string" || !value.summary.trim()) return undefined;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return undefined;
  return {
    id: value.id,
    role: value.role,
    summary: normalizeOneLine(value.summary),
    createdAt: value.createdAt,
  };
}

export function parseSummaryEvent(value: unknown): SessionSummaryEvent | undefined {
  if (!isRecord(value) || value.version !== SUMMARY_EVENT_VERSION) return undefined;
  if (value.kind === "clear") return { version: SUMMARY_EVENT_VERSION, kind: "clear" };
  if (value.kind === "upsert") {
    const entry = parsePersistedEntry(value.entry);
    return entry ? { version: SUMMARY_EVENT_VERSION, kind: "upsert", entry } : undefined;
  }
  if (value.kind === "config") {
    const event: SessionSummaryEvent = { version: SUMMARY_EVENT_VERSION, kind: "config" };
    if (typeof value.enabled === "boolean") event.enabled = value.enabled;
    if (value.modelRef === null || typeof value.modelRef === "string") {
      event.modelRef = value.modelRef === null ? null : value.modelRef.trim();
    }
    return event;
  }
  return undefined;
}

export function toPersistedEntry(entry: SessionSummaryEntry): PersistedSessionSummaryEntry {
  return {
    id: entry.id,
    role: entry.role,
    summary: normalizeOneLine(entry.summary),
    createdAt: entry.createdAt,
  };
}

export function upsertSummaryEntry(
  entries: readonly SessionSummaryEntry[],
  incoming: SessionSummaryEntry,
  cap = MAX_STORED_SUMMARIES,
): SessionSummaryEntry[] {
  const next = [...entries];
  const index = next.findIndex((entry) => entry.id === incoming.id);
  if (index >= 0) next[index] = { ...incoming, summary: normalizeOneLine(incoming.summary) };
  else next.push({ ...incoming, summary: normalizeOneLine(incoming.summary) });
  next.sort((a, b) => a.createdAt - b.createdAt);
  return next.slice(-Math.max(1, cap));
}

export function restoreSessionSummaryState(
  branch: readonly BranchEntryLike[],
  defaults: Pick<SessionSummaryState, "enabled" | "modelRef"> = { enabled: true },
): SessionSummaryState {
  let enabled = defaults.enabled;
  let modelRef = defaults.modelRef;
  let entries: SessionSummaryEntry[] = [];

  for (const raw of branch) {
    if (raw?.type !== "custom" || raw.customType !== SUMMARY_CUSTOM_ENTRY) continue;
    const event = parseSummaryEvent(raw.data);
    if (!event) continue;
    if (event.kind === "clear") {
      entries = [];
      continue;
    }
    if (event.kind === "config") {
      if (event.enabled !== undefined) enabled = event.enabled;
      if (event.modelRef !== undefined) modelRef = event.modelRef === null ? undefined : event.modelRef;
      continue;
    }
    entries = upsertSummaryEntry(entries, event.entry);
  }

  return { enabled, modelRef, entries };
}
