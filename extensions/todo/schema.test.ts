import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { UpdatePlanParamsSchema, normalizePlanSnapshot, PLAN_UPDATED_MESSAGE } from "./schema.js";

describe("todo schema", () => {
  it("accepts a valid update_plan payload", () => {
    const payload = {
      explanation: "Moving to verification.",
      plan: [
        { step: "Inspect Codex source", status: "completed" },
        { step: "Run tests", status: "in_progress" },
      ],
    };

    expect(Value.Check(UpdatePlanParamsSchema, payload)).toBe(true);
  });

  it("rejects unknown root and plan item fields", () => {
    expect(Value.Check(UpdatePlanParamsSchema, { plan: [], extra: true })).toBe(false);
    expect(Value.Check(UpdatePlanParamsSchema, { plan: [{ step: "A", status: "pending", id: 1 }] })).toBe(false);
  });

  it("rejects invalid statuses", () => {
    expect(Value.Check(UpdatePlanParamsSchema, { plan: [{ step: "A", status: "blocked" }] })).toBe(false);
  });

  it("normalizes snapshots by trimming explanation and step text", () => {
    expect(
      normalizePlanSnapshot({
        explanation: "  reason  ",
        plan: [{ step: "  Step A  ", status: "pending" }],
        updatedAt: 123,
      }),
    ).toEqual({
      explanation: "reason",
      plan: [{ step: "Step A", status: "pending" }],
      updatedAt: 123,
    });
  });

  it("omits blank explanations but rejects blank steps", () => {
    expect(normalizePlanSnapshot({ explanation: "   ", plan: [], updatedAt: 1 })).toEqual({ plan: [], updatedAt: 1 });
    expect(() => normalizePlanSnapshot({ plan: [{ step: " ", status: "pending" }], updatedAt: 1 })).toThrow(
      "plan item step must not be empty",
    );
  });

  it("exports Codex-compatible success text", () => {
    expect(PLAN_UPDATED_MESSAGE).toBe("Plan updated");
  });
});
