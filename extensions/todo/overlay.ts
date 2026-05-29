import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { PlanItem, PlanSnapshot } from "./schema.js";
import { hasInProgress, hasUnfinishedPlan, planCounts } from "./state.js";

const WIDGET_KEY = "codex-plan-overlay";
const DEFAULT_MAX_LINES = 12;

export interface PlanOverlayFormatOptions {
  maxLines?: number;
  forceVisible?: boolean;
}

export function formatPlanOverlayLines(
  snapshot: PlanSnapshot | null,
  theme: Pick<Theme, "fg" | "strikethrough">,
  width: number,
  options: PlanOverlayFormatOptions = {},
): string[] | undefined {
  if (!snapshot) return undefined;
  const forceVisible = options.forceVisible === true;
  if (!forceVisible && !hasUnfinishedPlan(snapshot)) return undefined;

  const maxLines = Math.max(1, Math.floor(options.maxLines ?? DEFAULT_MAX_LINES));
  const truncate = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
  const counts = planCounts(snapshot);
  const active = hasInProgress(snapshot);
  const headerColor = active ? "accent" : "dim";
  const headerIcon = active ? "●" : "○";
  const lines = [truncate(`${theme.fg(headerColor, headerIcon)} ${theme.fg(headerColor, `Plan (${counts.completed}/${counts.total})`)}`)];

  if (maxLines === 1) return lines;

  const rows = selectOverlayRows(snapshot.plan, maxLines - 1);
  rows.forEach((row, index) => {
    const connector = index === rows.length - 1 ? "└─" : "├─";
    const content = row.type === "item" ? formatOverlayItem(row.item, theme) : theme.fg("dim", row.text);
    lines.push(truncate(`${theme.fg("dim", connector)} ${content}`));
  });

  return lines;
}

type OverlayRow = { type: "item"; item: PlanItem } | { type: "summary"; text: string };

function selectOverlayRows(plan: PlanItem[], slots: number): OverlayRow[] {
  if (slots <= 0) return [];
  if (plan.length <= slots) return plan.map((item) => ({ type: "item", item }));

  const firstInProgress = plan.findIndex((item) => item.status === "in_progress");
  const firstUnfinished = plan.findIndex((item) => item.status === "pending" || item.status === "in_progress");
  const focusIndex = firstInProgress >= 0 ? firstInProgress : firstUnfinished;
  if (focusIndex < 0) return selectPrefixRows(plan, slots);

  const tailCount = plan.length - focusIndex;
  const hasCompletedPrefix = focusIndex > 0;
  if (tailCount + (hasCompletedPrefix ? 1 : 0) <= slots) {
    const completedSlots = slots - tailCount - (hasCompletedPrefix ? 1 : 0);
    const visibleStart = Math.max(0, focusIndex - completedSlots);
    return rowsForWindow(plan, visibleStart, plan.length);
  }

  const prefixSummarySlots = hasCompletedPrefix && slots >= 3 ? 1 : 0;
  const suffixSummarySlots = slots - prefixSummarySlots >= 2 ? 1 : 0;
  const itemSlots = Math.max(1, slots - prefixSummarySlots - suffixSummarySlots);
  const visibleEnd = Math.min(plan.length, focusIndex + itemSlots);
  return rowsForWindow(plan, focusIndex, visibleEnd);
}

function selectPrefixRows(plan: PlanItem[], slots: number): OverlayRow[] {
  const overflow = plan.length > slots;
  const itemSlots = Math.max(0, slots - (overflow ? 1 : 0));
  const rows: OverlayRow[] = plan.slice(0, itemSlots).map((item) => ({ type: "item", item }));
  const hidden = plan.length - itemSlots;
  if (hidden > 0) rows.push({ type: "summary", text: `+${hidden} more` });
  return rows;
}

function rowsForWindow(plan: PlanItem[], visibleStart: number, visibleEnd: number): OverlayRow[] {
  const rows: OverlayRow[] = [];
  if (visibleStart > 0) rows.push({ type: "summary", text: `+${visibleStart} completed hidden` });
  rows.push(...plan.slice(visibleStart, visibleEnd).map((item) => ({ type: "item" as const, item })));
  const hiddenAfter = plan.length - visibleEnd;
  if (hiddenAfter > 0) rows.push({ type: "summary", text: `+${hiddenAfter} more` });
  return rows;
}

function formatOverlayItem(item: PlanItem, theme: Pick<Theme, "fg" | "strikethrough">): string {
  if (item.status === "completed") {
    return `${theme.fg("success", "✓")} ${theme.strikethrough(theme.fg("dim", item.step))}`;
  }
  if (item.status === "in_progress") {
    return `${theme.fg("warning", "◐")} ${theme.fg("text", item.step)}`;
  }
  return `${theme.fg("dim", "○")} ${theme.fg("text", item.step)}`;
}

export class CodexPlanOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private holdCompleted = false;

  constructor(private readonly getSnapshot: () => PlanSnapshot | null) {}

  setUICtx(ctx: ExtensionUIContext): void {
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(options: { holdCompleted?: boolean } = {}): void {
    if (options.holdCompleted) this.holdCompleted = true;
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = formatPlanOverlayLines(snapshot, fallbackTheme, 80, { forceVisible: this.holdCompleted });
    if (!visible) {
      this.hide();
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          return {
            render: (width: number) => formatPlanOverlayLines(this.getSnapshot(), theme, width, { forceVisible: this.holdCompleted }) ?? [],
            invalidate: () => {
              this.widgetRegistered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  hideCompletedHold(): void {
    if (!this.holdCompleted) return;
    this.holdCompleted = false;
    if (!hasUnfinishedPlan(this.getSnapshot())) this.hide();
    else this.tui?.requestRender();
  }

  hide(): void {
    if (this.uiCtx && this.widgetRegistered) {
      this.uiCtx.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.hide();
    this.uiCtx = undefined;
    this.holdCompleted = false;
  }
}

const fallbackTheme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
};
