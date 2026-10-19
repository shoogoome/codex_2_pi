// A worker inherits the active context, not the parent's append-only archive.
// Never call forkFrom/open on the parent: both reparse all historical entries.
// Workers are one-shot sessions, so use the same in-memory mode as --no-session.
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

const TELEMETRY_TYPES = new Set([
  "cost-usage/snapshot",
  "token-speed/snapshot",
  "monitor/metric",
  "session-summary",
]);

/** Select in physical/path order; compaction projection reorders the summary itself. */
export function selectForkEntries(branch: readonly SessionEntry[]): SessionEntry[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  let start = 0;
  if (compactionIndex >= 0) {
    const compaction = branch[compactionIndex]!;
    if (compaction.type !== "compaction") throw new Error("Invalid compaction entry");
    start = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    if (start < 0 || start > compactionIndex) {
      // Fail closed rather than silently dropping recent messages or reverting
      // to an unbounded full-history copy on malformed session data.
      throw new Error("Cannot fork: compaction firstKeptEntryId is not on the active branch");
    }
  }

  // Preserve settings even when their entries precede the retained context.
  const settings = new Map<string, SessionEntry>();
  for (let i = 0; i < start; i++) {
    const entry = branch[i]!;
    if (entry.type === "model_change" || entry.type === "thinking_level_change") {
      settings.set(entry.type, entry);
    }
  }
  const selected = [...settings.values(), ...branch.slice(start)].filter((entry) => {
    if (entry.type === "custom" && TELEMETRY_TYPES.has(entry.customType)) return false;
    // These are filtered from provider requests by tasks/contextFilter, not
    // conversation. Do not copy thousands of worker progress notifications.
    return !(entry.type === "custom_message" && entry.customType === "tasks/progress");
  });
  // The retention boundary itself may be a removed metric/progress entry.
  // Move it to the next surviving retained entry, or to the compaction itself
  // (retain-none). Otherwise the SDK would silently omit the whole kept range.
  const compaction = compactionIndex >= 0 ? branch[compactionIndex] : undefined;
  let firstKeptEntryId: string | undefined;
  if (compaction?.type === "compaction") {
    const keptIds = new Set(branch.slice(start, compactionIndex).map((entry) => entry.id));
    firstKeptEntryId = selected.find((entry) => keptIds.has(entry.id))?.id ?? compaction.id;
  }
  // Keep IDs so context_edit references remain valid. Never mutate objects
  // owned by the live parent, including its compaction boundary.
  return selected.map((entry, i) => ({
    ...entry,
    ...(entry.id === compaction?.id ? { firstKeptEntryId } : {}),
    parentId: i === 0 ? null : selected[i - 1]!.id,
  }));
}

type ForkSdk = { SessionManager: Pick<typeof SessionManager, "inMemory"> };

type InMemorySessionManager = {
  // SessionManager intentionally keeps this low-level operation private. It is
  // used here only to retain the original IDs required by compaction/context_edit.
  _appendEntry(entry: SessionEntry): void;
};

/** Create a small independent, non-persistent child with provenance. */
export function createContextFork(
  sdk: ForkSdk,
  parentSessionFile: string,
  cwd: string,
  branch: readonly SessionEntry[],
): SessionManager {
  const child = sdk.SessionManager.inMemory(cwd, { parentSession: parentSessionFile }) as unknown as InMemorySessionManager;
  for (const entry of selectForkEntries(branch)) child._appendEntry(entry);
  return child as unknown as SessionManager;
}
