import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderProgressBar, type OpenSpecTask, type OpenSpecTaskSnapshot } from "./parser.js";

export interface OpenSpecProgressTheme {
  fg(color: string, text: string): string;
}

const plainTheme: OpenSpecProgressTheme = { fg: (_color, text) => text };

function frameRow(content: string, innerWidth: number, theme: OpenSpecProgressTheme): string {
  const shown = truncateToWidth(content, innerWidth, "…", true);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
  return `${theme.fg("border", "│")}${shown}${padding}${theme.fg("border", "│")}`;
}

function framedBorder(
  sideLeft: string,
  sideRight: string,
  label: string,
  innerWidth: number,
  theme: OpenSpecProgressTheme,
  labelColor: string,
): string {
  const available = Math.max(0, innerWidth - 1);
  const shown = truncateToWidth(` ${label} `, available, "…", false);
  const fill = "─".repeat(Math.max(0, available - visibleWidth(shown)));
  return `${theme.fg("border", `${sideLeft}─`)}${theme.fg(labelColor, shown)}${theme.fg("border", `${fill}${sideRight}`)}`;
}

export function formatSummaryLines(
  change: string,
  snapshot: OpenSpecTaskSnapshot,
  theme: OpenSpecProgressTheme = plainTheme,
  width = 80,
): string[] {
  if (snapshot.tasks.length === 0) return [];
  const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
  if (safeWidth < 4) return [truncateToWidth(`OpenSpec: ${change}`, safeWidth, "")];

  const innerWidth = safeWidth - 2;
  const barWidth = Math.max(4, Math.min(16, Math.floor((innerWidth - 22) / 2)));
  const percent = Math.round((snapshot.completed / snapshot.tasks.length) * 100);
  const current = snapshot.current ? snapshot.current.text : "全部任务已完成";
  const lines = [
    framedBorder("╭", "╮", `OpenSpec · ${change} · ${snapshot.completed}/${snapshot.tasks.length}`, innerWidth, theme, "dim"),
    frameRow(` 进度 ${renderProgressBar(snapshot, barWidth)} ${percent}%`, innerWidth, theme),
    frameRow(` 当前：${current}`, innerWidth, theme),
    framedBorder("╰", "╯", "Alt+O 切换 · Alt+Enter 查看", innerWidth, theme, "dim"),
  ];
  return lines.map((line) => visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "…") : line);
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
