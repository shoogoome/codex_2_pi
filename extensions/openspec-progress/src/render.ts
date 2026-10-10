import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderProgressBar, type OpenSpecTask, type OpenSpecTaskSnapshot } from "./parser.js";

export interface OpenSpecProgressTheme {
  fg(color: string, text: string): string;
}

const plainTheme: OpenSpecProgressTheme = { fg: (_color, text) => text };

export function formatSummaryLines(
  change: string,
  snapshot: OpenSpecTaskSnapshot,
  theme: OpenSpecProgressTheme = plainTheme,
  width = 80,
): string[] {
  if (snapshot.tasks.length === 0) return [];
  const safeWidth = Math.max(1, Math.floor(width));
  const barWidth = Math.max(4, Math.min(12, Math.floor((safeWidth - 48) / 2)));
  const first = `OpenSpec: ${change} · ${snapshot.completed}/${snapshot.tasks.length} · ${renderProgressBar(snapshot, barWidth)} · Alt+O 切换 · Alt+Enter 查看`;
  const current = snapshot.current ? `当前：${snapshot.current.text}` : "当前：全部任务已完成";
  return [
    truncateToWidth(first, safeWidth, "…"),
    truncateToWidth(current, safeWidth, "…"),
  ].map((line) => visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "…") : line).map((line) => theme.fg("text", line));
}

function taskGlyph(task: OpenSpecTask): string {
  if (task.completed) return "✓";
  if (task.inProgress) return "◐";
  return "○";
}

export function formatDetailLines(
  change: string,
  snapshot: OpenSpecTaskSnapshot,
  theme: OpenSpecProgressTheme = plainTheme,
  width = 80,
  maxLines = 16,
  offset = 0,
): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const capacity = Math.max(1, Math.floor(maxLines));
  const title = truncateToWidth(`OpenSpec: ${change} · ${snapshot.completed}/${snapshot.tasks.length} · Esc 关闭`, safeWidth, "…");
  const start = Math.max(0, Math.min(offset, Math.max(0, snapshot.tasks.length - capacity)));
  const visible = snapshot.tasks.slice(start, start + capacity);
  const lines = [theme.fg("accent", title)];
  if (start > 0) lines.push(theme.fg("dim", `↑ 还有 ${start} 项`));
  for (const task of visible) {
    const line = `${taskGlyph(task)} ${task.text}`;
    lines.push(theme.fg(task.completed ? "success" : task.inProgress ? "warning" : "text", truncateToWidth(line, safeWidth, "…")));
  }
  const after = snapshot.tasks.length - start - visible.length;
  if (after > 0) lines.push(theme.fg("dim", `↓ 还有 ${after} 项 · ↑/↓ 滚动`));
  return lines;
}
