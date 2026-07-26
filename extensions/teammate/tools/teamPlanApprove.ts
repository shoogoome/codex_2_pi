// teamPlanApprove — leader-side wrapper / sugar over send_message.
//
// When a teammate calls request_plan_approval, leader sees a notification like
//   [from researcher@team-x] {plan_approval_request, request_id:pa-..., plan:"..."}
// and must reply with a plan_approval_response protocol body. Hand-crafting that
// JSON by calling send_message is error-prone, so this tool wraps the same
// underlying mailbox post in a more ergonomic form.
//
// Implementation note: leader is in its OWN realm (the extension factory's pi),
// so getTeammateHandle(pi).mailbox IS the real mailbox the teammate's loop reads
// from. We bypass the send_message tool and post directly via mailbox.send —
// no ALS / identity resolution needed because leader's "from" is a constant.

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { buildPlanApprovalResponse } from "../protocol.js";
import type { MailboxMessage } from "../types.js";

const TeamPlanApproveParams = Type.Object({
  teammate: Type.String({
    description:
      "Teammate agentName who is awaiting plan approval. The teammate must have outstanding request_plan_approval — find request_id in the most recent [from <teammate>] notification.",
  }),
  request_id: Type.String({
    description:
      "request_id from teammate's plan_approval_request (begins with 'pa-').",
  }),
  approve: Type.Boolean({
    description: "true to approve the plan; false to reject.",
  }),
  feedback: Type.Optional(
    Type.String({
      description:
        "Optional reason. Required practically when approve=false so teammate knows what to fix.",
    }),
  ),
});

interface TeamPlanApproveDetails {
  action: "team_plan_approve";
  teammate?: string;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
}

const DESCRIPTION =
  "Respond to a teammate's plan_approval_request. Approve or reject their proposed plan, optionally with feedback.\n\n" +
  "## When to use\n" +
  "You'll see notifications like \"[from researcher@team-x] {plan_approval_request, request_id:pa-..., plan: '...'}\" in your context. Read the plan and decide:\n" +
  "- Approve straightforward plans matching the user's intent.\n" +
  "- Reject plans that risk data loss, miss the user's actual goal, or violate constraints. Provide feedback so teammate can revise.\n\n" +
  "## Equivalent to send_message\n" +
  "This tool is sugar over send_message {to:\"<name>\", message: '{\"type\":\"plan_approval_response\",\"request_id\":\"...\",\"approve\":...}'}. Use this for LLM ergonomics; the underlying protocol is identical.";

export function buildTeamPlanApproveTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeamPlanApproveParams, TeamPlanApproveDetails> {
  return {
    name: "team_plan_approve",
    label: "Approve or reject a teammate's plan",
    description: DESCRIPTION,
    parameters: TeamPlanApproveParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as {
        teammate?: string;
        request_id?: string;
        approve?: boolean;
        feedback?: string;
      };
      const teammate = (params.teammate ?? "").trim();
      const requestId = (params.request_id ?? "").trim();
      const approve = params.approve === true;
      const feedback = params.feedback;

      if (teammate.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "teammate must be non-empty" },
          ],
          isError: true,
          details: { action: "team_plan_approve" as const },
        };
      }
      if (requestId.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "request_id must be non-empty" },
          ],
          isError: true,
          details: { action: "team_plan_approve" as const, teammate },
        };
      }

      const handle = getTeammateHandle(pi);
      const body = buildPlanApprovalResponse(requestId, approve, feedback);
      const msg: MailboxMessage = {
        id: randomBytes(8).toString("hex"),
        from: "leader",
        to: teammate,
        body,
        timestamp: Date.now(),
        isProtocol: true,
      };
      handle.mailbox.send(msg);

      const details: TeamPlanApproveDetails = {
        action: "team_plan_approve",
        teammate,
        request_id: requestId,
        approve,
      };
      if (feedback !== undefined) details.feedback = feedback;

      return {
        content: [
          {
            type: "text" as const,
            text: `Plan approval response sent to ${teammate} (request_id=${requestId}, approve=${approve})`,
          },
        ],
        details,
      };
    },
  };
}
