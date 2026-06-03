// Leader-side notification channel — distinct from `teammate/event` (which
// is used for jsonl-persisted state replay and is filtered out of the LLM
// context).
//
// `teammate/notification` messages are intentionally NOT filtered: they are
// the mechanism by which teammates surface activity to the leader's main LLM
// as new conversation turns (DM) or informational entries (idle). The
// `triggerTurn` flag controls whether the leader is woken to react.
//
// Background: the leader is not a registered Mailbox receiver — the mailbox
// is for teammate-to-teammate routing only. Without this channel, messages
// addressed to "leader" would buffer indefinitely. See specs §D1.fix.2.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { logError } from "../tasks/logging.js";
import type { LeaderNotificationDetails } from "./types.js";

export const TEAMMATE_NOTIFICATION_CUSTOM_TYPE = "teammate/notification";

function buildContent(details: LeaderNotificationDetails): string {
  if (details.kind === "message") {
    return `[from ${details.agentId}] ${details.body}`;
  }
  return `[teammate ${details.agentId} idle]`;
}

/**
 * Inject a leader-facing notification into the main LLM session.
 *
 * @param triggerTurn — true for DMs (leader should wake up and respond),
 *                       false for idle status (informational only).
 */
export function postLeaderNotification(
  pi: Pick<ExtensionAPI, "sendMessage">,
  details: LeaderNotificationDetails,
  triggerTurn: boolean,
): void {
  try {
    pi.sendMessage(
      {
        customType: TEAMMATE_NOTIFICATION_CUSTOM_TYPE,
        content: buildContent(details),
        display: true,
        details,
      } as never,
      { triggerTurn },
    );
  } catch (e) {
    logError(e, "postLeaderNotification");
  }
}
