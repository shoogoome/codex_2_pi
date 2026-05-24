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

  const overflow = snapshot.plan.length > maxLines - 1;
  const maxItems = Math.max(0, maxLines - (overflow ? 2 : 1));
  const visibleItems = snapshot.plan.slice(0, maxItems);
  const hidden = snapshot.plan.length - visibleItems.length;

  visibleItems.forEach((item, index) => {
    const isLast = hidden === 0 && index === visibleItems.length - 1;
    lines.push(truncate(`${theme.fg("dim", isLast ? "└─" : "├─")} ${formatOverlayItem(item, theme)}`));
  });

  if (hidden > 0) {
    lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more`)}`));
  }

  return lines;
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
