/**
 * Thin fs boundary over the global input-history JSONL file.
 *
 * Writes use fs.appendFileSync which opens with the "a" (O_APPEND) flag,
 * giving atomic, non-interleaving appends across concurrent pi processes for
 * the small line-sized writes here. All IO is defensive: failures return an
 * empty result or are swallowed so history never blocks user input.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatEntry, parseLines, type HistoryEntry } from "./history.js";

/** Upper bound on how many recent entries a read returns. */
export const MAX_READ = 500;

/** Absolute path to the global history file, given a home directory. */
export function historyPath(home: string): string {
  return join(home, ".pi", "agent", "input-history.jsonl");
}

/**
 * Atomically append one entry to the history file, creating the parent
 * directory if needed. Never throws.
 */
export function appendEntry(path: string, entry: HistoryEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatEntry(entry));
  } catch {
    // History IO must never break input handling.
  }
}

/**
 * Read the most-recent `limit` entries (chronological order preserved).
 * Returns [] when the file is missing or unreadable, tolerating malformed
 * or partially written lines.
 */
export function readRecent(path: string, limit = MAX_READ): HistoryEntry[] {
  try {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const entries = parseLines(text);
    if (entries.length <= limit) return entries;
    return entries.slice(entries.length - limit);
  } catch {
    return [];
  }
}
