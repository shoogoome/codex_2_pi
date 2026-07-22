// extensions/cost-usage/src/lines.ts
//
// Pure edit/write diff line-churn parsing. No pi API access. Degrades to
// {added:0, removed:0} on malformed input so a metric failure can never break
// the agent loop.

import { emptyChurn, isString, type LineChurn } from "./types.js";

export interface ChurnDelta {
  added: number;
  removed: number;
  file?: string;
}

/**
 * Count added / removed lines in a unified diff string. A `+`/`-` prefixed line
 * is a change; the `+++`/`---` file headers and `@@` hunk headers are excluded.
 */
export function parseDiffChurn(diff: unknown): { added: number; removed: number } {
  if (!isString(diff) || diff.length === 0) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers
    if (line.startsWith("@@")) continue; // hunk header
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Approximate added-line count for a Write (whose tool result carries no diff):
 * the number of lines in the written content. Empty content → 0.
 */
export function countWriteLines(content: unknown): number {
  if (!isString(content) || content.length === 0) return 0;
  const parts = content.split("\n");
  // A trailing newline produces a final empty element that isn't a real line.
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/** Merge a churn delta into an accumulator (immutably), deduping file paths. */
export function addChurn(acc: LineChurn, delta: ChurnDelta): LineChurn {
  const files = acc.files.slice();
  if (delta.file && delta.file.length > 0 && !files.includes(delta.file)) {
    files.push(delta.file);
  }
  return {
    added: acc.added + Math.max(0, delta.added),
    removed: acc.removed + Math.max(0, delta.removed),
    files,
  };
}

export { emptyChurn };
