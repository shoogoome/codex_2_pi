// requestPlanApproval — a customTool injected into a teammate sub-session so
// the teammate can ask leader to approve a non-trivial plan before delegating
// destructive / mutating work.
//
// Why this is a builder (deps-injected) and not a generic registered tool:
//   The teammate sub-session lives in its OWN module realm (separate from the
//   leader). To resolve the leader-side promise that this tool awaits, we must
//   share state across that realm boundary. The two cross-realm channels are:
//     - The process-global `leaderBridge` (used here to deliver the request).
//     - A `pendingApprovals` map allocated in the LEADER realm at spawn time
//       and closed over by this tool's deps (so resolve() runs in leader-realm
//       and teammateLoop can find it when the response arrives).
//
//   Both are passed in via `BuildRequestPlanApprovalDeps`. Spawn-time wiring
//   (B.3 / B.4) lives in spawnTeammate.ts + teammateLoop.ts; this module is
//   intentionally standalone and unit-testable in isolation.

import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildPlanApprovalRequest } from "../protocol.js";
import type { LeaderChannel } from "../leaderBridge.js";
import type { TeammateIdentity } from "../types.js";

const RequestPlanApprovalParams = Type.Object({
  plan: Type.String({
    description:
      "Step-by-step plan you intend to execute. Be specific — leader will approve or reject based on this text alone.",
  }),
});

export interface PlanApprovalDecision {
  approve: boolean;
  feedback?: string;
}

interface PendingEntry {
  resolve: (d: PlanApprovalDecision) => void;
  reject: (e: Error) => void;
}

/**
 * Storage shape for in-flight plan approval requests. Lives in the LEADER
 * realm (allocated at teammate spawn time). Looked up by teammateLoop when a
 * plan_approval_response arrives so the awaiting tool can resolve.
 */
export interface PendingApprovals {
  set(requestId: string, entry: PendingEntry): void;
  get(requestId: string): PendingEntry | undefined;
  delete(requestId: string): void;
}

export interface BuildRequestPlanApprovalDeps {
  identity: TeammateIdentity;
  pendingApprovals: PendingApprovals;
  /**
   * Resolved at execute time so the tool follows the same stale-bridge rules
   * as teammateSendMessage. Returns undefined when no leader channel is
   * registered (offline / test-only standalone mode).
   */
  getLeaderChannel: () => LeaderChannel | undefined;
}

interface RequestPlanApprovalDetails {
  action: "request_plan_approval";
  request_id?: string;
  approved?: boolean;
  feedback?: string;
}

const DESCRIPTION =
  "Request leader's approval before executing a non-trivial plan.\n\n" +
  "## When to use\n" +
  "- Before ANY write/bash/edit operation that mutates the user's project (you don't have those tools directly — leader does — but if you delegate to leader via send_message, use this first to get explicit approval).\n" +
  "- Before destructive operations (delete files, force-push, drop database).\n" +
  "- When unsure whether the leader's high-level goal aligns with your specific approach.\n\n" +
  "## Behavior\n" +
  "- Sends your plan text to the leader and BLOCKS until leader replies via team_plan_approve.\n" +
  "- If approved: returns success; you may proceed with the plan.\n" +
  "- If rejected: returns error with leader's feedback; revise the plan and try again.\n\n" +
  "This tool is teammate-only — leader uses team_plan_approve to respond.";

function makeRequestId(): string {
  return `pa-${randomBytes(6).toString("hex")}`;
}

/**
 * Build a request_plan_approval tool bound to the given teammate identity and
 * leader-realm pendingApprovals storage. Inject into a teammate sub-session
 * via customTools at spawn time.
 */
export function buildRequestPlanApprovalTool(
  deps: BuildRequestPlanApprovalDeps,
): ToolDefinition<typeof RequestPlanApprovalParams, RequestPlanApprovalDetails> {
  return {
    name: "request_plan_approval",
    label: "Ask leader to approve the plan",
    description: DESCRIPTION,
    parameters: RequestPlanApprovalParams,
    executionMode: "parallel",
    async execute(_callId: unknown, raw: unknown, signal?: AbortSignal) {
      const params = raw as { plan?: string };
      const plan = (params.plan ?? "").trim();
      if (plan.length === 0) {
        return {
          content: [{ type: "text" as const, text: "plan must be non-empty" }],
          isError: true,
          details: { action: "request_plan_approval" as const },
        };
      }

      const channel = deps.getLeaderChannel();
      if (!channel) {
        return {
          content: [
            {
              type: "text" as const,
              text: "no leader channel registered (offline?); plan approval cannot be requested",
            },
          ],
          isError: true,
          details: { action: "request_plan_approval" as const },
        };
      }

      // Esc-pressed-before-execute fast path: don't even wait on leader.
      if (signal?.aborted) {
        return {
          content: [
            { type: "text" as const, text: "request_plan_approval aborted before start" },
          ],
          isError: true,
          details: { action: "request_plan_approval" as const },
        };
      }

      const requestId = makeRequestId();
      // onAbort needs to reach the pending entry to break the Promise out of
      // its hang. We store a closure on the deps map and reject it from the
      // signal handler. Without this an Esc on a teammate's blocked
      // request_plan_approval would silently keep the teammate stalled.
      const onAbort = (): void => {
        const entry = deps.pendingApprovals.get(requestId);
        if (entry) {
          deps.pendingApprovals.delete(requestId);
          entry.reject(new Error("aborted by user"));
        }
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });

      let decision: PlanApprovalDecision;
      try {
        decision = await new Promise<PlanApprovalDecision>((resolve, reject) => {
          deps.pendingApprovals.set(requestId, { resolve, reject });
          const body = buildPlanApprovalRequest(requestId, plan);
          try {
            channel.deliver(
              {
                kind: "message",
                agentId: deps.identity.agentId,
                to: "leader",
                body,
              },
              /* triggerTurn */ true,
            );
          } catch (err) {
            // If delivery throws synchronously, drop the pending entry and
            // surface the error so the awaiter never hangs.
            deps.pendingApprovals.delete(requestId);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      } catch (err) {
        if (signal) signal.removeEventListener("abort", onAbort);
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `request_plan_approval failed: ${message}` },
          ],
          isError: true,
          details: { action: "request_plan_approval" as const, request_id: requestId },
        };
      }
      if (signal) signal.removeEventListener("abort", onAbort);

      const details: RequestPlanApprovalDetails = {
        action: "request_plan_approval",
        request_id: requestId,
        approved: decision.approve,
      };
      if (decision.feedback !== undefined) details.feedback = decision.feedback;

      if (decision.approve) {
        const text = decision.feedback
          ? `Plan approved by leader.\n\nFeedback: ${decision.feedback}`
          : "Plan approved by leader.";
        return {
          content: [{ type: "text" as const, text }],
          details,
        };
      }
      const text = decision.feedback
        ? `Plan rejected by leader.\n\nFeedback: ${decision.feedback}`
        : "Plan rejected by leader.";
      return {
        content: [{ type: "text" as const, text }],
        isError: true,
        details,
      };
    },
  };
}
