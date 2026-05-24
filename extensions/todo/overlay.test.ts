import { describe, expect, it, vi } from "vitest";
import { CodexPlanOverlay, formatPlanOverlayLines } from "./overlay.js";
import { setPlan } from "./state.js";
import type { PlanSnapshot } from "./schema.js";

const plainTheme: any = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => `~${text}~`,
};

function snapshot(count = 3): PlanSnapshot {
  return {
    plan: Array.from({ length: count }, (_, index) => ({
      step: `Step ${index + 1}`,
      status: index === 0 ? "completed" : index === 1 ? "in_progress" : "pending",
    })),
    updatedAt: 1,
  };
}

describe("plan overlay formatting", () => {
  it("returns undefined for no unfinished work unless completed display is held", () => {
    expect(formatPlanOverlayLines(null, plainTheme, 80)).toBeUndefined();
    expect(formatPlanOverlayLines({ plan: [{ step: "Done", status: "completed" }], updatedAt: 1 }, plainTheme, 80)).toBeUndefined();
    expect(formatPlanOverlayLines({ plan: [{ step: "Done", status: "completed" }], updatedAt: 1 }, plainTheme, 80, { forceVisible: true })).toEqual([
      "○ Plan (1/1)",
      "└─ ✓ ~Done~",
    ]);
  });

  it("formats unfinished plans with heading, connectors, and glyphs", () => {
    expect(formatPlanOverlayLines(snapshot(), plainTheme, 80)).toEqual([
      "● Plan (1/3)",
      "├─ ✓ ~Step 1~",
      "├─ ◐ Step 2",
      "└─ ○ Step 3",
    ]);
  });

  it("truncates long lists and adds an overflow summary", () => {
    const lines = formatPlanOverlayLines(snapshot(20), plainTheme, 80, { maxLines: 5 });
    expect(lines).toEqual(["● Plan (1/20)", "├─ ✓ ~Step 1~", "├─ ◐ Step 2", "├─ ○ Step 3", "└─ +17 more"]);
  });
});

describe("CodexPlanOverlay", () => {
  it("registers and clears an above-editor widget", () => {
    const setWidget = vi.fn();
    const requestRender = vi.fn();
    const ui: any = { setWidget };
    const overlay = new CodexPlanOverlay(() => snapshot());

    overlay.setUICtx(ui);
    overlay.update();

    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });
    const factory = setWidget.mock.calls[0][1];
    const component = factory({ requestRender }, plainTheme);
    expect(component.render(80)).toEqual(["● Plan (1/3)", "├─ ✓ ~Step 1~", "├─ ◐ Step 2", "└─ ○ Step 3"]);

    overlay.update();
    expect(requestRender).toHaveBeenCalledTimes(1);

    setPlan(null);
    overlay.hide();
    expect(setWidget).toHaveBeenLastCalledWith("codex-plan-overlay", undefined, { placement: "aboveEditor" });
  });

  it("holds completed plans until agent_start hides them", () => {
    const setWidget = vi.fn();
    const ui: any = { setWidget };
    const completed: PlanSnapshot = { plan: [{ step: "Done", status: "completed" }], updatedAt: 1 };
    const overlay = new CodexPlanOverlay(() => completed);

    overlay.setUICtx(ui);
    overlay.update({ holdCompleted: true });
    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });

    overlay.hideCompletedHold();
    expect(setWidget).toHaveBeenLastCalledWith("codex-plan-overlay", undefined, { placement: "aboveEditor" });
  });
});
