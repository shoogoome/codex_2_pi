/**
 * MEMORY.md index model. The index is a human- and model-readable table of
 * contents the harness injects every (re-armed) turn so the model knows what
 * memory exists and where to read/edit it.
 *
 * Line format (round-trippable):
 *   - `relative/path.md` — **Topic name** (type): description
 *
 * parseIndex tolerates hand-edits: it reads any line matching that shape and
 * ignores the rest, so the model can freely add prose around the list.
 */
import { isMemoryType, type IndexEntry, type MemoryType } from "./types.js";

const HEADER = "# Memory index";

const INTRO =
  "Long-term memory for this project. Each entry below is a topic file you can " +
  "read and edit. Keep this index in sync when you add or remove topics.";

/** A blank index used when scaffolding a fresh memory dir. */
export function defaultIndexTemplate(): string {
  return `${HEADER}\n\n${INTRO}\n\n## Topics\n\n_(none yet)_\n`;
}

const ENTRY_RE =
  /^-\s+`([^`]+)`\s+—\s+\*\*(.+?)\*\*\s+\((user|feedback|project|reference)\)(?::\s*(.*))?$/;

/** Parse the entries out of a MEMORY.md string. Non-matching lines are ignored. */
export function parseIndex(md: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = ENTRY_RE.exec(line.trim());
    if (!m) continue;
    const type: MemoryType = isMemoryType(m[3]) ? m[3] : "project";
    out.push({
      path: m[1].trim(),
      name: m[2].trim(),
      type,
      description: (m[4] ?? "").trim(),
    });
  }
  return out;
}

/** Format a single index entry line. */
export function formatEntryLine(entry: IndexEntry): string {
  const desc = entry.description ? `: ${entry.description}` : "";
  return `- \`${entry.path}\` — **${entry.name}** (${entry.type})${desc}`;
}

/**
 * Build a full MEMORY.md from a set of entries, grouped by type in canonical
 * order. Entries within a group are sorted by name for stable output.
 */
export function buildIndex(entries: IndexEntry[]): string {
  const lines: string[] = [HEADER, "", INTRO, "", "## Topics", ""];
  if (entries.length === 0) {
    lines.push("_(none yet)_", "");
    return lines.join("\n");
  }
  const sorted = [...entries].sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  for (const e of sorted) {
    lines.push(formatEntryLine(e));
  }
  lines.push("");
  return lines.join("\n");
}
