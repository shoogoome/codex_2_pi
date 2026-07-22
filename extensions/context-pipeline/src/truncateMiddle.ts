// extensions/context-pipeline/src/truncateMiddle.ts
//
// ① Middle truncation: keep the head and tail, replace the middle with an
// ellipsis marker noting how many chars were dropped. Cuts on Unicode code
// point boundaries so surrogate pairs (emoji, etc.) are never split.

export interface TruncateResult {
  content: string;
  /** Number of original code points removed (excludes the marker text). */
  removedChars: number;
}

/**
 * Truncate `content` to roughly `budget` code points by removing the middle.
 *
 * - If the content already fits within `budget`, it is returned unchanged with
 *   `removedChars: 0`.
 * - Otherwise the head keeps `floor(budget/2)` code points, the tail keeps the
 *   remaining `ceil(budget/2)`, and the removed count is
 *   `total - budget`.
 */
export function truncateMiddle(content: string, budget: number): TruncateResult {
  const safeBudget = budget > 0 ? Math.floor(budget) : 0;
  const chars = Array.from(content);
  const total = chars.length;

  if (total <= safeBudget) {
    return { content, removedChars: 0 };
  }

  const headLen = Math.floor(safeBudget / 2);
  const tailLen = safeBudget - headLen; // ceil(budget/2)
  const removed = total - headLen - tailLen;

  const head = chars.slice(0, headLen).join("");
  const tail = tailLen > 0 ? chars.slice(total - tailLen).join("") : "";
  const marker = `\n… ${removed} chars truncated …\n`;

  return { content: head + marker + tail, removedChars: removed };
}
