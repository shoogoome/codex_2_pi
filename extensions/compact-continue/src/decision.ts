export type ContinuationReason =
  | "tool-result"
  | "tool-use"
  | "truncated-response"
  | "unfinished-plan";

export interface ContinuationDecision {
  reason: ContinuationReason;
}

interface MessageLike {
  role?: unknown;
  stopReason?: unknown;
}

interface EntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEntry(value: unknown): EntryLike | null {
  return isRecord(value) ? value : null;
}

function asMessage(value: unknown): MessageLike | null {
  return isRecord(value) ? value : null;
}

function latestConversationMessage(branchEntries: readonly unknown[]): MessageLike | null {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = asEntry(branchEntries[index]);
    if (!entry || entry.type !== "message") continue;
    const message = asMessage(entry.message);
    if (!message) continue;
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      return message;
    }
  }
  return null;
}

function latestAssistantMessage(branchEntries: readonly unknown[]): MessageLike | null {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = asEntry(branchEntries[index]);
    if (!entry || entry.type !== "message") continue;
    const message = asMessage(entry.message);
    if (message?.role === "assistant") return message;
  }
  return null;
}

function latestPlanHasUnfinishedWork(branchEntries: readonly unknown[]): boolean {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = asEntry(branchEntries[index]);
    if (!entry || entry.type !== "custom" || entry.customType !== "codex-plan") continue;
    if (!isRecord(entry.data) || !Array.isArray(entry.data.plan)) continue;

    return entry.data.plan.some((item) => {
      if (!isRecord(item)) return false;
      return item.status === "pending" || item.status === "in_progress";
    });
  }
  return false;
}

/**
 * Conservatively decide whether threshold compaction interrupted executable work.
 *
 * Strong signals only: a tool result still needs an assistant follow-up, a
 * truncated/tool-use response is incomplete, or the latest persisted plan still
 * has unfinished steps. A normal completed assistant response does not continue.
 */
export function decideContinuation(branchEntries: readonly unknown[]): ContinuationDecision | null {
  const lastMessage = latestConversationMessage(branchEntries);
  if (lastMessage?.role === "toolResult") return { reason: "tool-result" };

  const assistant = latestAssistantMessage(branchEntries);
  if (assistant?.stopReason === "length") return { reason: "truncated-response" };
  if (assistant?.stopReason === "toolUse") return { reason: "tool-use" };

  if (latestPlanHasUnfinishedWork(branchEntries)) return { reason: "unfinished-plan" };
  return null;
}
