import type { SubagentLifecycleStatus, SubagentSummary } from "./types.js";
import { previewText } from "./text.js";

const ACTIVE_STATUSES = new Set<SubagentLifecycleStatus>(["starting", "running"]);
const DEFAULT_MAX_ROWS = 5;
const PREVIEW_LIMIT = 72;

export interface RunningSubagentWidgetOptions {
  maxRows?: number;
}

export function formatRunningSubagentWidget(
  summaries: SubagentSummary[],
  now = Date.now(),
  options: RunningSubagentWidgetOptions = {},
): string[] | undefined {
  const active = summaries
    .filter((summary) => ACTIVE_STATUSES.has(summary.status))
    .sort((left, right) => left.startedAt - right.startedAt);

  if (active.length === 0) return undefined;

  const maxRows = Math.max(1, Math.floor(options.maxRows ?? DEFAULT_MAX_ROWS));
  const visible = active.slice(0, maxRows);
  const title = active.length === 1 ? "Subagent running:" : `Subagents running (${active.length}):`;
  const lines = [title, ...visible.map((summary) => formatRunningSubagentLine(summary, now))];
  const hidden = active.length - visible.length;
  if (hidden > 0) lines.push(`… ${hidden} more running`);
  return lines;
}

function formatRunningSubagentLine(summary: SubagentSummary, now: number): string {
  const parts = [`● ${summary.taskName}`, summary.status, formatElapsed(now - summary.startedAt)];
  const preview = summary.lastAssistantPreview
    ? previewText(summary.lastAssistantPreview, PREVIEW_LIMIT)
    : summary.lastError
      ? `Error: ${previewText(summary.lastError, PREVIEW_LIMIT)}`
      : undefined;
  if (preview) parts.push(preview);
  return parts.join(" — ");
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m${seconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes.toString().padStart(2, "0")}m`;
}
