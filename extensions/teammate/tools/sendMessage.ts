import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { getCurrentTeammate } from "../als.js";
import { emitTeammateEvent } from "../eventEmit.js";
import { detectShutdownProtocol } from "../shutdownHandshake.js";
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

      handle.mailbox.send(msg);
      emitTeammateEvent(pi, { kind: "message_sent", msg });

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
