// teammateInterrupt — leader-side stop-loss: stop what a teammate is doing right
// now and make it read your message immediately.
//
// Deliberately sugar over (interruptTeammate + mailbox.send), same shape as
// team_plan_approve: the leader is in its own module realm and owns the real
// mailbox, so posting directly is correct and avoids ALS/identity resolution.

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTeammateHandle } from "../handle.js";
import { resolveLeaderAgentAddress } from "../messageAddress.js";
import { detectShutdownProtocol } from "../shutdownHandshake.js";
import { describeInterrupt, interruptTeammate } from "../interruptTeammate.js";
import { emitTeammateEvent } from "../eventEmit.js";
import { getTasksHandle } from "../../tasks/handle.js";
import type { MailboxMessage } from "../types.js";

const TeammateInterruptParams = Type.Object({
  teammate: Type.String({
    description:
      "Teammate full agentId ('name@team', preferred) or unique agentName. Check team_roster() if unsure.",
  }),
  message: Type.String({
    description:
      "What the teammate should do instead. Delivered as its next turn, immediately after the interruption. Be specific and self-contained — it may have lost the in-flight work it was doing.",
  }),
});

interface TeammateInterruptDetails {
  action: "teammate_interrupt";
  teammate?: string;
  agentId?: string;
  interrupted?: boolean;
  wasBusy?: boolean;
  inTool?: string;
  busyForMs?: number;
  reason?: string;
}

const DESCRIPTION =
  "Stop what a teammate is doing RIGHT NOW and make it read your message immediately. The teammate stays alive — only its current turn is aborted, then your message becomes its next turn." +
  "\n\n## Use when\n" +
  "- The teammate is visibly heading the wrong way (wrong design, wrong file, wrong approach) and you want to correct it before it burns more time/tokens.\n" +
  "- The teammate is inside a long-running command (its `task_status` diagnostics show `current tool: bash for 6m`) and therefore CANNOT read a normal message — a plain `send_message` would just sit in the queue until that call returns.\n" +
  "- You need to change its instructions mid-flight. Re-spawning loses its context and prior work; this keeps both.\n" +
  "\n## Three different mechanisms — pick deliberately\n" +
  "| Tool | Effect | Teammate afterwards |\n" +
  "|---|---|---|\n" +
  "| `send_message` | Queued; read only after the current tool call returns | alive, keeps working |\n" +
  "| **`teammate_interrupt`** | **Aborts the current turn, then delivers your message as the next turn** | **alive, keeps its context** |\n" +
  "| `task_kill` | Terminates the teammate (dispose) | gone — its context is lost |\n" +
  "\nPrefer this over `task_kill` for course-correction: killing is for a teammate that is genuinely stuck or no longer wanted. Killing to \"get it to read a message\" throws away everything it had done." +
  "\n\n## Notes\n" +
  "- Work in progress is DISCARDED. If the teammate was mid-edit or mid-analysis, say so in `message` and tell it whether to redo, verify, or abandon that work — assume it does not remember what it was doing.\n" +
  "- Safe on an idle teammate: nothing is aborted and the message simply starts its next turn.\n" +
  "- Also clears a teammate that is blocked waiting on a plan approval you no longer intend to answer.";

export function buildTeammateInterruptTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof TeammateInterruptParams, TeammateInterruptDetails> {
  return {
    name: "teammate_interrupt",
    label: "Interrupt a teammate and redirect it",
    description: DESCRIPTION,
    promptSnippet:
      "Stop a teammate's current turn now and deliver a redirect message immediately",
    parameters: TeammateInterruptParams,
    executionMode: "parallel",
    renderShell: "self",
    async execute(_callId: unknown, raw: unknown) {
      const params = raw as { teammate?: string; message?: string };
      const teammate = (params.teammate ?? "").trim();
      const body = params.message ?? "";

      if (teammate.length === 0) {
        return {
          content: [{ type: "text" as const, text: "teammate must be non-empty" }],
          isError: true,
          details: { action: "teammate_interrupt" as const },
        };
      }
      if (body.trim().length === 0) {
        return {
          content: [{ type: "text" as const, text: "message must be non-empty" }],
          isError: true,
          details: { action: "teammate_interrupt" as const, teammate },
        };
      }

      const handle = getTeammateHandle(pi);
      const resolved = resolveLeaderAgentAddress(
        teammate,
        handle.teamStore,
        handle.mailbox,
      );
      if (!resolved.ok) {
        return {
          content: [{ type: "text" as const, text: resolved.error }],
          isError: true,
          details: { action: "teammate_interrupt" as const, teammate },
        };
      }
      const agentId = resolved.agentId;

      let store: ReturnType<typeof getTasksHandle>["store"];
      try {
        store = getTasksHandle(pi).store;
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: `cannot interrupt: task store unavailable (${(e as Error)?.message ?? String(e)})`,
            },
          ],
          isError: true,
          details: { action: "teammate_interrupt" as const, teammate, agentId },
        };
      }

      // Order matters: abort FIRST, then deliver. Delivered first, the message
      // would be picked up as a turn while the old turn is still being torn
      // down. interruptTeammate awaits session.abort(), which internally waits
      // for idle — so by the time it returns, the loop is ready for this message.
      const result = await interruptTeammate(pi, store, handle, agentId);
      const summary = describeInterrupt(result, agentId);

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: summary }],
          isError: true,
          details: {
            action: "teammate_interrupt" as const,
            teammate,
            agentId,
            interrupted: false,
            reason: result.reason,
          },
        };
      }

      const msg: MailboxMessage = {
        id: randomBytes(8).toString("hex"),
        from: "leader",
        to: agentId,
        body,
        timestamp: Date.now(),
        isProtocol: detectShutdownProtocol(body) !== undefined,
      };
      const sent = handle.mailbox.send(msg);
      if (!sent.ok) {
        // The interrupt already happened. Say so plainly — the teammate is now
        // idle with no new instruction, which the leader must know about.
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Interrupted '${agentId}', but the follow-up message could not be delivered: ${sent.error}\n` +
                `The teammate is now idle and still alive — send it instructions with send_message once the address is fixed.`,
            },
          ],
          isError: true,
          details: {
            action: "teammate_interrupt" as const,
            teammate,
            agentId,
            interrupted: true,
            wasBusy: result.wasBusy,
          },
        };
      }

      for (const recipient of sent.recipientAgentIds) {
        emitTeammateEvent(pi, { kind: "message_sent", msg: { ...msg, to: recipient } });
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${summary}\n` +
              (result.wasBusy
                ? "It does not know what it was doing before — your message is its only instruction for the next turn."
                : ""),
          },
        ],
        details: {
          action: "teammate_interrupt" as const,
          teammate,
          agentId,
          interrupted: true,
          wasBusy: result.wasBusy,
          ...(result.wasInTool !== undefined ? { inTool: result.wasInTool } : {}),
          ...(result.busyForMs !== undefined ? { busyForMs: result.busyForMs } : {}),
        },
      };
    },
  };
}
