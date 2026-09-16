import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { getCurrentTeammate } from "../als.js";
import { emitTeammateEvent } from "../eventEmit.js";
import {
  detectShutdownProtocol,
  parseShutdownRequest,
  parseShutdownResponse,
} from "../shutdownHandshake.js";
import { postLeaderNotification } from "../leaderNotification.js";
import { getLeaderChannel } from "../leaderBridge.js";
import { parseAgentId } from "../mailbox.js";
import {
  resolveLeaderAgentAddress,
  resolvePeerAgentAddress,
} from "../messageAddress.js";
import type { MailboxMessage } from "../types.js";

const SendMessageParams = Type.Object({
  to: Type.String({
    description:
      "Recipient agentName/full agentId, 'leader', '*' to broadcast to the sender's team, or '*@team' for an explicit leader broadcast.",
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
  "Send a message to one teammate by name/full agentId, or broadcast to peers in one team.\n\n" +
  "## Identity resolution\n" +
  "- Teammate senders are bound to their own team; a bare name resolves only there and cross-team agentIds are rejected.\n" +
  "- Leader senders should prefer a full agentId (`name@team`). A bare name works only when unique across teams; ambiguity is an error.\n" +
  "- to=\"*\" broadcasts only inside the teammate sender's team. A leader can use `*@team`.\n\n" +
  "## Plain-text vs protocol messages\n" +
  "- Plain text: Sent verbatim. The recipient sees `[from <sender>] <message>` in their next turn.\n" +
  "- JSON-string protocol bodies (shutdown_request / shutdown_response): Detected automatically and marked isProtocol:true.\n\n" +
  "## Sending to the leader\n" +
  "- to=\"leader\" surfaces as a new conversation turn in the leader's main LLM context (it does NOT go through the mailbox).\n" +
  "- A teammate to=\"*\" broadcast also surfaces a copy to the leader.\n\n" +
  "Returns immediately after delivery (or buffering if an explicitly-addressed recipient is offline).";

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
      const from = identity?.agentId ?? "leader";
      const isProtocol = detectShutdownProtocol(body) !== undefined;
      const isToLeader = to === "leader";
      const isBroadcast = to === "*" || to.startsWith("*@");

      let resolvedTo = to;
      if (!isToLeader && !isBroadcast) {
        const resolved = identity
          ? resolvePeerAgentAddress(
              to,
              identity,
              handle.teamStore,
              handle.mailbox,
            )
          : resolveLeaderAgentAddress(to, handle.teamStore, handle.mailbox);
        if (!resolved.ok) {
          return {
            content: [{ type: "text" as const, text: resolved.error }],
            isError: true,
            details: {
              action: "send_message" as const,
              to,
              from,
              isProtocol,
            },
          };
        }
        resolvedTo = resolved.agentId;
      } else if (isBroadcast) {
        if (identity) {
          if (to.startsWith("*@") && to.slice(2) !== identity.teamName) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Teammate '${identity.agentId}' cannot broadcast outside team '${identity.teamName}'`,
                },
              ],
              isError: true,
              details: {
                action: "send_message" as const,
                to,
                from,
                isProtocol,
              },
            };
          }
          // The mailbox derives the team from the full sender identity.
          resolvedTo = "*";
        } else if (to === "*") {
          const teams = new Set<string>();
          for (const team of handle.teamStore.list()) {
            if (team.memberAgentIds.length > 0) teams.add(team.teamName);
          }
          for (const agentId of handle.mailbox.onlineAgents()) {
            const parsed = parseAgentId(agentId);
            if (parsed) teams.add(parsed.teamName);
          }
          if (teams.size !== 1) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    teams.size === 0
                      ? "Leader broadcast has no resolvable team; use '*@teamName'"
                      : "Leader broadcast is ambiguous; use '*@teamName'",
                },
              ],
              isError: true,
              details: {
                action: "send_message" as const,
                to,
                from,
                isProtocol,
              },
            };
          }
          resolvedTo = `*@${Array.from(teams)[0]!}`;
        } else if (to.length <= 2) {
          return {
            content: [
              { type: "text" as const, text: "Broadcast team must be non-empty" },
            ],
            isError: true,
            details: { action: "send_message" as const, to, from, isProtocol },
          };
        }
      }

      const msg: MailboxMessage = {
        id: randomBytes(8).toString("hex"),
        from,
        to: resolvedTo,
        body,
        timestamp: Date.now(),
        isProtocol,
      };

      // The leader is not a mailbox receiver. Everything else routes through
      // the full-identity mailbox and may return a deterministic address error.
      let routedAgentIds: string[] = [];
      if (!isToLeader) {
        const sendResult = handle.mailbox.send(msg);
        if (!sendResult.ok) {
          return {
            content: [{ type: "text" as const, text: sendResult.error }],
            isError: true,
            details: {
              action: "send_message" as const,
              to,
              from,
              isProtocol,
            },
          };
        }
        routedAgentIds = sendResult.recipientAgentIds;
      }
      // Persist one canonical event per recipient. This makes unacknowledged
      // peer messages replayable after a leader session restart; wildcard
      // broadcasts are never stored as ambiguous targets.
      const persistedMessages = isToLeader
        ? [msg]
        : routedAgentIds.map((agentId) => ({ ...msg, to: agentId }));
      for (const routedMessage of persistedMessages) {
        emitTeammateEvent(pi, { kind: "message_sent", msg: routedMessage });
      }

      const protocol = detectShutdownProtocol(body);
      if (protocol === "request") {
        const req = parseShutdownRequest(body);
        if (req) {
          emitTeammateEvent(pi, {
            kind: "shutdown_request",
            agentId: resolvedTo,
            requestId: req.request_id,
          });
        }
      } else if (protocol === "response") {
        const resp = parseShutdownResponse(body);
        if (resp) {
          emitTeammateEvent(pi, {
            kind: "shutdown_response",
            agentId: resolvedTo,
            requestId: resp.request_id,
            approve: resp.approve,
            ...(resp.feedback !== undefined ? { feedback: resp.feedback } : {}),
          });
        }
      }

      // Teammate-to-leader and teammate broadcasts are surfaced in the leader
      // session. Prefer the registered bridge; local pi is a test fallback.
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
          to: resolvedTo,
          from,
          isProtocol,
        },
      };
    },
  };
}
