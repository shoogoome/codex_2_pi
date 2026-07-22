/**
 * Byte-budget truncation for a single context file. Mirrors codex's
 * DEFAULT_PROJECT_DOC_MAX_BYTES = 32 * 1024. When content exceeds the budget we
 * cut at a line boundary (so we never split a multi-byte character or a markdown
 * code fence mid-line) and append a machine-readable `[truncated]` marker.
 */

export const DEFAULT_MAX_BYTES = 32 * 1024;

export interface BudgetResult {
  content: string;
  truncated: boolean;
}

/**
 * Truncate `content` to at most `max` UTF-8 bytes, rounding down to the previous
 * newline so we never break a multi-byte char. Appends a truncation notice
 * describing how many bytes were kept vs. the original size.
 */
export function applyBudget(
  content: string,
  max: number = DEFAULT_MAX_BYTES,
): BudgetResult {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= max) {
    return { content, truncated: false };
  }

  // Reserve room for the truncation notice.
  const notice = (kept: number) =>
    `\n\n… [truncated: kept ${kept} of ${totalBytes} bytes]`;
  const reserve = Buffer.byteLength(notice(totalBytes), "utf8") + 16;
  const budget = Math.max(0, max - reserve);

  // Binary-search the longest character prefix whose byte length fits.
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(content.slice(0, mid), "utf8") <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let cut = content.slice(0, lo);
  // Prefer a line boundary so we don't leave a dangling half-line / fence.
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > 0) cut = cut.slice(0, lastNl);

  const keptBytes = Buffer.byteLength(cut, "utf8");
  return { content: cut + notice(keptBytes), truncated: true };
}
