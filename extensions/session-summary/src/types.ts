export const SUMMARY_CUSTOM_ENTRY = "session-summary";
export const SUMMARY_EVENT_VERSION = 1;
export const MAX_STORED_SUMMARIES = 100;

export type SummaryRole = "user" | "agent";

export interface SessionSummaryEntry {
  id: string;
  role: SummaryRole;
  summary: string;
  createdAt: number;
  pending?: boolean;
}

export interface SessionSummaryState {
  enabled: boolean;
  modelRef?: string;
  entries: SessionSummaryEntry[];
}

export type PersistedSessionSummaryEntry = Omit<SessionSummaryEntry, "pending">;

export type SessionSummaryEvent =
  | {
      version: typeof SUMMARY_EVENT_VERSION;
      kind: "config";
      enabled?: boolean;
      modelRef?: string | null;
    }
  | {
      version: typeof SUMMARY_EVENT_VERSION;
      kind: "upsert";
      entry: PersistedSessionSummaryEntry;
    }
  | {
      version: typeof SUMMARY_EVENT_VERSION;
      kind: "clear";
    };

export interface BranchEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}
