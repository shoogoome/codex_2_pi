import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { getCurrentTeammate } from "../als.js";
import { emitTeammateEvent } from "../eventEmit.js";
import { detectShutdownProtocol, parseShutdownRequest, parseShutdownResponse } from "../shutdownHandshake.js";
import { postLeaderNotification } from "../leaderNotification.js";
import { getLeaderChannel } from "../leaderBridge.js";
import type { MailboxMessage } from "../types.js";

const SendMessageParams = Type.Object({
  to: Type.String({
    description: "Recipient agentName, or '*' to broadcast to the sender's team.",
  }),
  message: Type.String({
    description: "Plain text message body or JSON protocol body.",
  }),
});

interface SendMessageDetails {
  action: "send_message";
  to?: string;
  from?: string;
  isProtocol?: boolean;
}

const DESCRIPTION =
  "Send a message to one teammate by name, or broadcast to \"*\" (all members of the same team, excluding the sender).\n\n" +
  "## Identity resolution\n" +
  "- When called from leader/main LLM context: from = \"leader\"\n" +
  "- When called from a teammate (inside its AsyncLocalStorage scope): from = current teammate's agentName\n\n" +
  "## Plain-text vs protocol messages\n" +
  "- Plain text: Sent verbatim. The recipient sees `[from <sender>] <message>` in their next turn.\n" +
  "- JSON-string protocol bodies (shutdown_request / shutdown_response): Detected automatically and marked isProtocol:true. The teammate's loop handles shutdown_request by replying with shutdown_response and exiting.\n\n" +
  "## Sending to the leader\n" +
  "- to=\"leader\" surfaces as a new conversation turn in the leader's main LLM context (it does NOT go through the mailbox; the leader is not a mailbox receiver).\n" +
  "- to=\"*\" broadcasts to peer teammates AND surfaces a copy to the leader for visibility.\n\n" +
  "Returns immediately after delivery (or buffering if recipient is offline). The recipient processes the message in their next turn.";

export function buildSendMessageTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof SendMessageParams, SendMessageDetails> {
  return {
    name: "send_message",
    label: "Send a message to a teammate",
    description: DESCRIPTION,
    parameters: SendMessageParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { to?: string; message?: string };
      const to = (params.to ?? "").trim();
      const body = params.message ?? "";
      if (to.length === 0) {
        return {
          content: [{ type: "text" as const, text: "to must be non-empty" }],
          isError: true,
          details: { action: "send_message" as const },
        };
      }
      if (body.length === 0) {
        return {
          content: [{ type: "text" as const, text: "message must be non-empty" }],
          isError: true,
          details: { action: "send_message" as const, to },
        };
      }

      const handle = getTeammateHandle(pi);
      const identity = getCurrentTeammate();
      const from = identity?.agentName ?? "leader";
      const isProtocol = detectShutdownProtocol(body) !== undefined;
      const msg: MailboxMessage = {
        id: randomBytes(8).toString("hex"),
        from,
        to,
        body,
        timestamp: Date.now(),
        isProtocol,
      };

      // "leader" is not registered as a Mailbox receiver — sending there
      // would just buffer the message indefinitely. Skip the mailbox in
      // that case and rely solely on the leader-notification channel below.
      // Broadcasts ("*") still go through the mailbox so peers receive them;
      // the leader notification is layered on top.
      const isToLeader = to === "leader";
      if (!isToLeader) {
        handle.mailbox.send(msg);
      }
      emitTeammateEvent(pi, { kind: "message_sent", msg });

      const protocol = detectShutdownProtocol(body);
      if (protocol === "request") {
        const req = parseShutdownRequest(body);
        if (req) {
          emitTeammateEvent(pi, {
            kind: "shutdown_request",
            agentId: to,
            requestId: req.request_id,
          });
        }
      } else if (protocol === "response") {
        const resp = parseShutdownResponse(body);
        if (resp) {
          emitTeammateEvent(pi, {
            kind: "shutdown_response",
            agentId: to,
            requestId: resp.request_id,
            approve: resp.approve,
            ...(resp.feedback !== undefined ? { feedback: resp.feedback } : {}),
          });
        }
      }

      // Leader notification: when a teammate (identity defined) DMs the
      // leader or broadcasts to "*", surface the message as a new turn in
      // the leader's main LLM context. Suppressed when the sender is the
      // leader itself (identity undefined) — would otherwise notify itself.
      //
      // Routing: a teammate runs in an ISOLATED sub-session whose `pi` cannot
      // reach the real leader (different extension runtime / eventBus). So we
      // deliver through the process-global leaderBridge, whose channel was
      // registered by the leader's own session_start and closes over the
      // leader's pi. Fall back to the local pi only when no leader channel is
      // registered (e.g. standalone unit tests) — best-effort.
      if (identity && (isToLeader || to === "*")) {
        const details = {
          kind: "message" as const,
          agentId: identity.agentId,
          to,
          body,
        };
        const channel = getLeaderChannel();
        if (channel) {
          channel.deliver(details, /* triggerTurn */ true);
        } else {
          postLeaderNotification(pi, details, /* triggerTurn */ true);
        }
      }

      return {
        content: [{ type: "text" as const, text: `Message sent to ${to}` }],
        details: {
          action: "send_message" as const,
          to,
          from,
          isProtocol,
        },
      };
    },
  };
}
