import { Type, type Static } from "typebox";

export const PLAN_UPDATED_MESSAGE = "Plan updated";
export const PLAN_CUSTOM_ENTRY = "codex-plan";

export const StepStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
]);

export const PlanItemSchema = Type.Object(
  {
    step: Type.String({ description: "One short plan step." }),
    status: StepStatusSchema,
  },
  { additionalProperties: false },
);

export const UpdatePlanParamsSchema = Type.Object(
  {
    explanation: Type.Optional(Type.String({ description: "Optional rationale for a structural plan change." })),
    plan: Type.Array(PlanItemSchema, { description: "The full latest list of plan steps." }),
  },
  { additionalProperties: false },
);

export type StepStatus = Static<typeof StepStatusSchema>;
export type PlanItem = Static<typeof PlanItemSchema>;
export type UpdatePlanParams = Static<typeof UpdatePlanParamsSchema>;

export interface PlanSnapshot {
  explanation?: string;
  plan: PlanItem[];
  updatedAt: number;
}

export type UpdatePlanDetails = PlanSnapshot;

export function isStepStatus(value: unknown): value is StepStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

export function normalizeUpdatePlanParams(params: UpdatePlanParams, updatedAt = Date.now()): PlanSnapshot {
  return normalizePlanSnapshot({ ...params, updatedAt });
}

export function normalizePlanSnapshot(raw: unknown): PlanSnapshot {
  if (!isRecord(raw)) throw new Error("plan snapshot must be an object");
  if (!Array.isArray(raw.plan)) throw new Error("plan snapshot requires a plan array");

  const explanation = typeof raw.explanation === "string" ? raw.explanation.trim() : undefined;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
  const plan = raw.plan.map((item, index) => normalizePlanItem(item, index));

  return {
    ...(explanation ? { explanation } : {}),
    plan,
    updatedAt,
  };
}

function normalizePlanItem(raw: unknown, index: number): PlanItem {
  if (!isRecord(raw)) throw new Error(`plan item ${index} must be an object`);
  if (typeof raw.step !== "string") throw new Error(`plan item ${index} requires a string step`);
  const step = raw.step.trim();
  if (!step) throw new Error("plan item step must not be empty");
  if (!isStepStatus(raw.status)) throw new Error(`plan item ${index} has invalid status`);
  return { step, status: raw.status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
