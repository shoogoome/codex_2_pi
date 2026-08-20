import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { SessionSummaryEntry } from "./types.js";

export const SESSION_SUMMARY_WIDGET_KEY = "session-summary-thread";

export interface SummaryOverlayTheme {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

export interface SummaryOverlaySnapshot {
  entries: readonly SessionSummaryEntry[];
  modelLabel: string;
  maxRows: number;
  error?: string;
}

export interface SummaryOverlayFormatOptions {
  /** Number of entries hidden below the viewport; 0 means follow newest. */
  scrollOffset?: number;
  scrollHint?: string;
}

const identityTheme: SummaryOverlayTheme = { fg: (_color, text) => text, bold: (text) => text };

function clampScrollOffset(snapshot: SummaryOverlaySnapshot, requested: number): number {
  const capacity = Math.max(1, Math.floor(snapshot.maxRows));
  return Math.max(0, Math.min(Math.floor(requested), Math.max(0, snapshot.entries.length - capacity)));
}

function frameRow(content: string, innerWidth: number, theme: SummaryOverlayTheme): string {
  const shown = truncateToWidth(content, innerWidth, "…", true);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
  return `${theme.fg("border", "│")}${shown}${padding}${theme.fg("border", "│")}`;
}

function framedBorder(
  sideLeft: string,
  sideRight: string,
  label: string,
  innerWidth: number,
  theme: SummaryOverlayTheme,
  labelColor: string,
): string {
  const available = Math.max(0, innerWidth - 1);
  const shown = truncateToWidth(` ${label} `, available, "…", false);
  const fill = "─".repeat(Math.max(0, available - visibleWidth(shown)));
  return `${theme.fg("border", `${sideLeft}─`)}${theme.fg(labelColor, shown)}${theme.fg("border", `${fill}${sideRight}`)}`;
}

export function formatSummaryOverlayLines(
  snapshot: SummaryOverlaySnapshot,
  theme: SummaryOverlayTheme = identityTheme,
  width = 80,
  options: SummaryOverlayFormatOptions = {},
): string[] {
  const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
  const count = snapshot.entries.length;
  const title = `summary · ${snapshot.modelLabel} · ${count} 条${snapshot.error ? " · fallback" : ""}`;

  // A real terminal is much wider, but keep the strict Component width contract
  // even under tiny synthetic widths used by tests/RPC hosts.
  if (safeWidth < 4) return [truncateToWidth(title, safeWidth, "")];

  const innerWidth = safeWidth - 2;
  const maxRows = Math.max(1, Math.floor(snapshot.maxRows));
  const scrollOffset = clampScrollOffset(snapshot, options.scrollOffset ?? 0);
  const bodyEnd = Math.max(0, count - scrollOffset);
  const bodyStart = Math.max(0, bodyEnd - maxRows);
  const visible = snapshot.entries.slice(bodyStart, bodyEnd);
  const lines = [framedBorder("╭", "╮", title, innerWidth, theme, "dim")];

  if (count === 0) {
    lines.push(frameRow(theme.fg("dim", "  等待首轮对话…"), innerWidth, theme));
  } else {
    for (const entry of visible) {
      const label = entry.role === "user" ? "你" : "AI";
      const pending = entry.pending ? theme.fg("dim", "  ◌") : "";
      lines.push(frameRow(` ${theme.fg("dim", label.padEnd(2, " "))} ${theme.fg("dim", entry.summary)}${pending}`, innerWidth, theme));
    }
  }

  const older = bodyStart;
  const newer = count - bodyEnd;
  const range = count > 0 ? `${bodyStart + 1}-${bodyEnd}/${count}` : "0/0";
  const direction = [
    older > 0 ? `↑${older}` : "",
    newer > 0 ? `↓${newer}` : "",
  ].filter(Boolean).join(" ");
  const scrollHint = count > maxRows
    ? `${range}${direction ? ` · ${direction}` : ""} · ${options.scrollHint ?? "Alt+↑/↓ 滚动"}`
    : range;
  lines.push(framedBorder("╰", "╯", scrollHint, innerWidth, theme, "dim"));
  return lines;
}

export class SessionSummaryOverlay {
  private ui: ExtensionUIContext | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private scrollOffset = 0;

  constructor(
    private readonly getSnapshot: () => SummaryOverlaySnapshot,
    private readonly scrollHint = "Alt+↑/↓ 滚动",
  ) {}

  setUI(ui: ExtensionUIContext): void {
    if (this.ui === ui) return;
    this.hide();
    this.ui = ui;
    this.scrollOffset = 0;
  }

  /** Preserve the visible historical window when new rows arrive while scrolled up. */
  onEntriesChanged(previousCount: number, nextCount: number): void {
    if (this.scrollOffset > 0 && nextCount > previousCount) {
      this.scrollOffset += nextCount - previousCount;
    }
    this.clampOffset();
    this.tui?.requestRender();
  }

  scrollOlder(rows = 1): void {
    this.setScrollOffset(this.scrollOffset + Math.max(1, Math.floor(rows)));
  }

  scrollNewer(rows = 1): void {
    this.setScrollOffset(this.scrollOffset - Math.max(1, Math.floor(rows)));
  }

  scrollToLatest(): void {
    this.setScrollOffset(0);
  }

  resetScroll(): void {
    this.scrollOffset = 0;
    this.tui?.requestRender();
  }

  show(): void {
    if (!this.ui) return;
    if (!this.registered) {
      this.ui.setWidget(
        SESSION_SUMMARY_WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => formatSummaryOverlayLines(
              this.getSnapshot(),
              theme,
              width,
              { scrollOffset: this.scrollOffset, scrollHint: this.scrollHint },
            ),
            invalidate: () => {
              this.registered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.registered = true;
      return;
    }
    this.tui?.requestRender();
  }

  hide(): void {
    if (this.ui && this.registered) {
      this.ui.setWidget(SESSION_SUMMARY_WIDGET_KEY, undefined, { placement: "aboveEditor" });
    }
    this.registered = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.hide();
    this.ui = undefined;
    this.scrollOffset = 0;
  }

  private maxScrollOffset(): number {
    const snapshot = this.getSnapshot();
    return Math.max(0, snapshot.entries.length - Math.max(1, Math.floor(snapshot.maxRows)));
  }

  private clampOffset(): void {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset()));
  }

  private setScrollOffset(offset: number): void {
    const next = Math.max(0, Math.min(offset, this.maxScrollOffset()));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.tui?.requestRender();
  }
}
