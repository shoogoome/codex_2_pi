// teammateSendMessage — the send_message tool variant injected into a teammate
// sub-session as a `customTool`, carrying the teammate's identity in its
// closure rather than resolving it from AsyncLocalStorage.
//
// Why this exists (root cause, spike-proven):
//   A teammate runs in its OWN sub-session whose extension runtime is a
//   SEPARATE module realm. The generic send_message tool (registered by the
//   teammate extension) resolves the sender via getCurrentTeammate(), which
//   reads a module-level AsyncLocalStorage in als.ts. But teammateLoop calls
//   runAsTeammate() in the LEADER realm's als.ts instance — a DIFFERENT
//   AsyncLocalStorage object than the sub-session realm's. So inside the
//   sub-session tool, getCurrentTeammate() returns undefined and `from`
//   wrongly becomes "leader", which both mislabels the message AND suppresses
//   the leader notification (the `if (identity && ...)` guard fails).
//
//   Fix: bind the identity at spawn time. spawnTeammate injects THIS tool via
//   customTools with the teammate's identity captured in the closure. It also
//   delivers leader notifications through the process-global leaderBridge
//   (the only channel that crosses the sub-session boundary), never the
//   sub-session's isolated pi/mailbox/handle.

import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getLeaderChannel } from "../leaderBridge.js";
import { detectShutdownProtocol } from "../shutdownHandshake.js";
import type { TeammateIdentity } from "../types.js";

const SendMessageParams = Type.Object({
  to: Type.String({
    description: "Recipient agentName, 'leader', or '*' to broadcast to the team.",
  }),
  message: Type.String({
    description: "Plain text message body or JSON protocol body.",
  }),
});

interface TeammateSendMessageDetails {
  action: "send_message";
  to?: string;
  from?: string;
  isProtocol?: boolean;
  delivered?: boolean;
}

const DESCRIPTION =
  "Send a message to the team leader or a teammate.\n\n" +
  "- to=\"leader\": surfaces in the leader's main session as a new turn.\n" +
  "- to=\"<name>\" / \"*\": addressed to a peer / all peers.\n" +
  "- JSON protocol bodies (shutdown_request/response) are detected automatically.\n\n" +
  "Returns after the message is dispatched.";

/**
 * Build a send_message tool bound to a specific teammate identity. Injected
 * into the teammate sub-session via customTools so the sender identity does
 * not depend on cross-realm AsyncLocalStorage.
 */
export function buildTeammateSendMessageTool(
  identity: TeammateIdentity,
): ToolDefinition<typeof SendMessageParams, TeammateSendMessageDetails> {
  return {
    name: "send_message",
    label: "Send a message to the leader or a teammate",
    description: DESCRIPTION,
    parameters: SendMessageParams,
    executionMode: "parallel",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { to?: string; message?: string };
      const to = (params.to ?? "").trim();
      const body = params.message ?? "";
      if (to.length === 0) {
        return {
          content: [{ type: "text" as const, text: "to must be non-empty" }],
          isError: true,
          details: { action: "send_message" as const, from: identity.agentName },
        };
      }
      if (body.length === 0) {
        return {
          content: [{ type: "text" as const, text: "message must be non-empty" }],
          isError: true,
          details: { action: "send_message" as const, to, from: identity.agentName },
        };
      }

      const isProtocol = detectShutdownProtocol(body) !== undefined;
      const isToLeader = to === "leader";

      // Deliver to the leader through the process-global bridge. This is the
      // ONLY channel that crosses the sub-session boundary — the sub-session's
      // own mailbox/handle/pi cannot reach the real leader.
      let delivered = false;
      if (isToLeader || to === "*") {
        const channel = getLeaderChannel();
        if (channel) {
          channel.deliver(
            {
              kind: "message",
              agentId: identity.agentId,
              to,
              body,
            },
            /* triggerTurn */ true,
          );
          delivered = true;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: delivered
              ? `Message sent to ${to}`
              : `Message addressed to ${to} (no leader channel; not delivered)`,
          },
        ],
        details: {
          action: "send_message" as const,
          to,
          from: identity.agentName,
          isProtocol,
          delivered,
        },
      };
    },
  };
}

/** Generate a mailbox message id (kept for parity with the generic tool). */
export function _makeMessageId(): string {
  return randomBytes(8).toString("hex");
}
