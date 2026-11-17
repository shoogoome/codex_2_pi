import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { disambiguateRepoNames } from "./state.js";
import { DEFAULT_MAX_VISIBLE_ROWS, type RepoBranchRecord } from "./types.js";

export const REPO_BRANCH_WIDGET_KEY = "repo-branch-bar";

export interface RepoBranchOverlayTheme {
  fg(color: string, text: string): string;
}

export interface RepoBranchOverlaySnapshot {
  records: readonly RepoBranchRecord[];
  maxRows?: number;
}

const identityTheme: RepoBranchOverlayTheme = { fg: (_color, text) => text };

function frameRow(content: string, innerWidth: number, theme: RepoBranchOverlayTheme): string {
  const shown = truncateToWidth(content, innerWidth, "…", true);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(shown)));
  return `${theme.fg("border", "│")}${shown}${padding}${theme.fg("border", "│")}`;
}

function framedBorder(
  sideLeft: string,
  sideRight: string,
  label: string,
  innerWidth: number,
  theme: RepoBranchOverlayTheme,
  labelColor: string,
): string {
  const available = Math.max(0, innerWidth - 1);
  const shown = truncateToWidth(` ${label} `, available, "…", false);
  const fill = "─".repeat(Math.max(0, available - visibleWidth(shown)));
  return `${theme.fg("border", `${sideLeft}─`)}${theme.fg(labelColor, shown)}${theme.fg("border", `${fill}${sideRight}`)}`;
}

function rightAlignBoxLines(lines: readonly string[], width: number): string[] {
  return lines.map((raw) => {
    const line = visibleWidth(raw) > width ? truncateToWidth(raw, width, "…") : raw;
    const leftPad = " ".repeat(Math.max(0, width - visibleWidth(line)));
    return `${leftPad}${line}`;
  });
}

export function formatRepoBranchBoxLines(
  snapshot: RepoBranchOverlaySnapshot,
  theme: RepoBranchOverlayTheme = identityTheme,
  width = 80,
): string[] {
  const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
  const count = snapshot.records.length;
  const title = `仓库分支 · ${count}`;

  if (safeWidth < 4) {
    return rightAlignBoxLines([truncateToWidth(title, safeWidth, "")], safeWidth);
  }

  const maxInnerWidth = safeWidth - 2;
  const maxRows = Math.max(1, Math.floor(snapshot.maxRows ?? DEFAULT_MAX_VISIBLE_ROWS));
  const titleInnerNeed = visibleWidth(title) + 4;

  if (count === 0) {
    const emptyLabel = "暂无记录";
    const emptyInnerNeed = visibleWidth(emptyLabel) + 2;
    const innerWidth = Math.min(maxInnerWidth, Math.max(titleInnerNeed, emptyInnerNeed));
    const lines = [
      framedBorder("╭", "╮", title, innerWidth, theme, "dim"),
      frameRow(` ${theme.fg("dim", emptyLabel)}`, innerWidth, theme),
      theme.fg("border", `╰${"─".repeat(Math.max(0, innerWidth))}╯`),
    ];
    return rightAlignBoxLines(lines, safeWidth);
  }

  const visible = disambiguateRepoNames(snapshot.records).slice(0, maxRows);
  const hiddenCount = count - visible.length;
  const hiddenLabel = hiddenCount > 0 ? `还有 ${hiddenCount} 个 · /repo-branch list` : "";
  const hiddenInnerNeed = hiddenCount > 0 ? visibleWidth(hiddenLabel) + 4 : 0;

  const longestName = Math.max(...visible.map((record) => visibleWidth(record.displayName)));
  const nameWidth = Math.min(longestName, Math.max(6, Math.floor(maxInnerWidth * 0.42)));

  let maxRowInnerNeed = 0;
  const rowEntries = visible.map((record) => {
    const shownName = truncateToWidth(record.displayName, nameWidth, "…");
    const gap = " ".repeat(Math.max(2, nameWidth - visibleWidth(shownName) + 2));
    const rowWidth = 3 + visibleWidth(shownName) + gap.length + visibleWidth(record.branch) + 1;
    if (rowWidth > maxRowInnerNeed) maxRowInnerNeed = rowWidth;
    return { shownName, gap, branch: record.branch };
  });

  const innerWidth = Math.min(maxInnerWidth, Math.max(titleInnerNeed, hiddenInnerNeed, maxRowInnerNeed));
  const lines = [framedBorder("╭", "╮", title, innerWidth, theme, "dim")];

  for (const row of rowEntries) {
    const rowText = ` ${theme.fg("accent", "●")} ${theme.fg("text", row.shownName)}${row.gap}${theme.fg("success", row.branch)} `;
    lines.push(frameRow(rowText, innerWidth, theme));
  }

  if (hiddenCount > 0) {
    lines.push(framedBorder("╰", "╯", hiddenLabel, innerWidth, theme, "dim"));
  } else {
    lines.push(theme.fg("border", `╰${"─".repeat(Math.max(0, innerWidth))}╯`));
  }

  return rightAlignBoxLines(lines, safeWidth);
}

export class RepoBranchOverlay {
  private ui: ExtensionUIContext | undefined;
  private tui: TUI | undefined;
  private registered = false;

  constructor(private readonly getSnapshot: () => RepoBranchOverlaySnapshot) {}

  setUI(ui: ExtensionUIContext): void {
    if (this.ui === ui) return;
    this.hide();
    this.ui = ui;
  }

  show(): void {
    if (!this.ui) return;
    if (!this.registered) {
      this.ui.setWidget(
        REPO_BRANCH_WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => formatRepoBranchBoxLines(this.getSnapshot(), theme, width),
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
      this.ui.setWidget(REPO_BRANCH_WIDGET_KEY, undefined, { placement: "aboveEditor" });
    }
    this.registered = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.hide();
    this.ui = undefined;
  }
}
