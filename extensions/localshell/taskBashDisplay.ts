// Pure rendering helpers for task_bash result.
//
// Mirrors the pattern of compact-ui/src/write-display-utils.ts:
// a small set of pure functions that the renderResult hook composes,
// kept side-effect free so they're trivially testable.

const HEAD_LINES = 1;

export interface TaskBashSummary {
  /** First HEAD_LINES of `text` — typically the "completed (exit N) taskId=..." line.
   *  When `hasMore=false` the head equals the entire input verbatim, so the caller
   *  can render it without further joins. */
  head: string;
  /** True if there's anything to fold; false means the caller should render `head`
   *  directly (no "lines hidden" hint needed). */
  hasMore: boolean;
  /** Number of lines hidden when collapsed. Only meaningful when `hasMore=true`. */
  hiddenCount: number;
}

/**
 * Split `text` on either \n or \r\n and decide whether to fold.
 *
 * Folding kicks in once `lines.length > HEAD_LINES + 1`, i.e. there are at
 * least 2 hidden lines after the head — folding a single trailing line would
 * just trade one line for one "hidden" hint, which is pointless.
 */
export function summarizeTaskBashOutput(text: string): TaskBashSummary {
  const lines = text.split(/\r?\n/);
  if (lines.length <= HEAD_LINES + 1) {
    return { head: text, hasMore: false, hiddenCount: 0 };
  }
  const head = lines.slice(0, HEAD_LINES).join("\n");
  const hiddenCount = lines.length - HEAD_LINES;
  return { head, hasMore: true, hiddenCount };
}
