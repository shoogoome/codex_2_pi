// extensions/tasks/format-utils.ts
//
// Shared text formatters for task UI surfaces (panel widget rows, summary
// renderer, teammate widget). Each is a pure function — no I/O, no Pi
// dependencies — so they live in the leaf framework module and avoid the
// extensions/tasks ↔ extensions/teammate import cycle.

/** "0 tokens" / "750 tokens" / "12.3k tokens" */
export function formatTokens(n: number): string {
  if (n <= 0) return "0 tokens";
  if (n < 1000) return `${n} tokens`;
  return `${(n / 1000).toFixed(1)}k tokens`;
}

/** "30s" / "1m 23s" / "2h 5m" */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}
