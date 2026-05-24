import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CodexPlanOverlay } from "./overlay.js";
import { renderUpdatePlanCall, renderUpdatePlanResult } from "./render.js";
import {
  PLAN_CUSTOM_ENTRY,
  PLAN_UPDATED_MESSAGE,
  UpdatePlanParamsSchema,
  normalizeUpdatePlanParams,
  type PlanSnapshot,
  type UpdatePlanDetails,
} from "./schema.js";
import { getPlan, restorePlanFromBranch, setPlan, shouldShowRestoredOverlay, hasUnfinishedPlan } from "./state.js";

const PROMPT_GUIDELINE = [
  "Use update_plan for non-trivial, multi-step, ambiguous, or long-running work; do not use it for simple one-step tasks.",
  "Call update_plan with the full latest plan snapshot, using short one-sentence steps and statuses pending, in_progress, or completed.",
  "Keep exactly one in_progress step while work remains, mark completed steps before moving on, and mark all steps completed when done.",
  "When changing plan structure, include explanation; after calling update_plan, do not repeat the full plan because Pi displays it already.",
];

export default function todoExtension(pi: ExtensionAPI) {
  const overlay = new CodexPlanOverlay(getPlan);

  function restore(ctx: ExtensionContext): PlanSnapshot | null {
    const snapshot = restorePlanFromBranch(ctx.sessionManager.getBranch());
    setPlan(snapshot);
    return snapshot;
  }

  function updateOverlayForRestored(ctx: ExtensionContext, snapshot: PlanSnapshot | null): void {
    if (!ctx.hasUI) return;
    overlay.setUICtx(ctx.ui);
    if (shouldShowRestoredOverlay(snapshot)) overlay.update();
    else overlay.hide();
  }

  pi.registerTool<typeof UpdatePlanParamsSchema, UpdatePlanDetails>({
    name: "update_plan",
    label: "Update Plan",
    description:
      "Updates the task plan. Provide an optional explanation and a full list of plan items, each with a step and status. At most one step should be in_progress at a time.",
    promptSnippet: "Track multi-step work with a Codex-style full-snapshot plan.",
    promptGuidelines: PROMPT_GUIDELINE,
    parameters: UpdatePlanParamsSchema,
    executionMode: "sequential",
    renderCall(args, theme) {
      return renderUpdatePlanCall(args, theme);
    },
    renderResult(result, { expanded }, theme) {
      return renderUpdatePlanResult(result, expanded, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const snapshot = normalizeUpdatePlanParams(params);
      pi.appendEntry<PlanSnapshot>(PLAN_CUSTOM_ENTRY, snapshot);
      setPlan(snapshot);
      if (ctx.hasUI) {
        overlay.setUICtx(ctx.ui);
        overlay.update({ holdCompleted: !hasUnfinishedPlan(snapshot) && snapshot.plan.length > 0 });
      }
      return { content: [{ type: "text", text: PLAN_UPDATED_MESSAGE }], details: snapshot };
    },
  });

  pi.on("session_start", async (_event, ctx) => updateOverlayForRestored(ctx, restore(ctx)));
  pi.on("session_tree", async (_event, ctx) => updateOverlayForRestored(ctx, restore(ctx)));
  pi.on("session_compact", async (_event, ctx) => updateOverlayForRestored(ctx, restore(ctx)));
  pi.on("agent_start", async () => overlay.hideCompletedHold());
  pi.on("session_shutdown", async () => overlay.dispose());
}
