import { describe, expect, it } from "vitest";
import { formatPlanUpdateLines, formatStatusGlyph, formatUpdatePlanCallTitle } from "./render.js";
import type { PlanSnapshot } from "./schema.js";

const snapshot: PlanSnapshot = {
  explanation: "Moving to verification.",
  plan: [
    { step: "Inspect Codex source", status: "completed" },
    { step: "Implement update_plan", status: "in_progress" },
    { step: "Run verification", status: "pending" },
  ],
  updatedAt: 1,
};

describe("todo render helpers", () => {
  it("formats status glyphs", () => {
    expect(formatStatusGlyph("completed")).toBe("✓");
    expect(formatStatusGlyph("in_progress")).toBe("◐");
    expect(formatStatusGlyph("pending")).toBe("○");
  });

  it("formats tool call titles", () => {
    expect(formatUpdatePlanCallTitle({ plan: [{ step: "A", status: "pending" }] })).toBe("update_plan 1 step");
    expect(formatUpdatePlanCallTitle({ plan: [{ step: "A", status: "pending" }, { step: "B", status: "pending" }] })).toBe(
      "update_plan 2 steps",
    );
  });

  it("formats Codex-style plan update lines", () => {
    expect(formatPlanUpdateLines(snapshot)).toEqual([
      "• Updated Plan",
      "  └ Moving to verification.",
      "    ✓ Inspect Codex source",
      "    ◐ Implement update_plan",
      "    ○ Run verification",
    ]);
  });

  it("handles empty plans", () => {
    expect(formatPlanUpdateLines({ plan: [], updatedAt: 1 })).toEqual(["• Updated Plan", "  └ (no steps provided)"]);
  });
});
