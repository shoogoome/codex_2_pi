/**
 * Pure, fs-free helpers for input-history.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested without touching disk, the real home directory, or a shell.
 */

/** One persisted prompt entry, as stored per-line in the JSONL file. */
export interface HistoryEntry {
  /** Unix epoch millis when the prompt was captured. */
  ts: number;
  /** The raw prompt text as submitted. */
  text: string;
  /** Working directory at capture time (optional). */
  cwd?: string;
}

/**
 * Parse a JSONL blob into entries, tolerating blank / malformed / partially
 * written lines (e.g. a trailing line another process is mid-append on).
 * Any line that is not valid JSON with a string `text` is silently skipped.
 */
export function parseLines(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.text !== "string") continue;
    const entry: HistoryEntry = {
      ts: typeof obj.ts === "number" ? obj.ts : 0,
      text: obj.text,
    };
    if (typeof obj.cwd === "string") entry.cwd = obj.cwd;
    entries.push(entry);
  }
  return entries;
}

/** Serialize a single entry to one JSONL line (with trailing newline). */
export function formatEntry(entry: HistoryEntry): string {
  return JSON.stringify(entry) + "\n";
}

/**
 * Whether an incoming input should be captured to history.
 * Only interactive, non-empty, non-slash-command text is stored.
 */
export function shouldCapture(text: string, source: string): boolean {
  if (source !== "interactive") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  return true;
}

/**
 * True when the new text is identical to the previously captured text,
 * used to de-duplicate immediate consecutive repeats.
 */
export function isSameAsLast(prevText: string | undefined, text: string): boolean {
  if (prevText === undefined) return false;
  return prevText.trim() === text.trim();
}

/**
 * Build a newest-first, de-duplicated list of prompt strings for recall.
 * Input `entries` are in chronological (oldest-first) file order. Duplicates
 * keep only their most-recent occurrence. Result is capped at `cap`.
 */
export function toRecallList(entries: HistoryEntry[], cap = 500): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i].text;
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= cap) break;
  }
  return result;
}

/**
 * Case-insensitive substring filter over an already newest-first list,
 * preserving order. An empty query returns the list unchanged.
 */
export function filterHistory(items: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) => item.toLowerCase().includes(q));
}
