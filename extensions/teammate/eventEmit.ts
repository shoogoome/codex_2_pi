// emitTeammateEvent — persist mutating actions to the session jsonl as a custom
// message. The reducer in jsonlEvents.ts replays these on session_start to
// rebuild final state.
//
// Mirrors the pattern from extensions/tasks/progress.ts (spike-validated):
// sendMessage with `display:false` keeps the event off the TUI message stream,
// triggerTurn:false avoids waking the agent, and the context filter (below)
// strips the entries from the LLM's next provider request payload.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeammateEvent } from "./types.js";
import { logError } from "../tasks/logging.js";

export const TEAMMATE_EVENT_CUSTOM_TYPE = "teammate/event";

export function emitTeammateEvent(
  pi: Pick<ExtensionAPI, "sendMessage">,
  event: TeammateEvent,
): void {
  try {
    pi.sendMessage(
      {
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        content: event.kind,
        display: false,
        details: event,
      } as never,
      { triggerTurn: false },
    );
  } catch (e) {
    logError(e, "emitTeammateEvent");
  }
}

/**
 * Strip teammate/event entries from the LLM's `context` event before the
 * provider request is built. Pi appends customMessages to the session as
 * `{role:"custom", customType, ...}`; we drop ours so the LLM doesn't see
 * internal team-management noise in its context.
 */
export function installTeammateEventContextFilter(
  pi: Pick<ExtensionAPI, "on">,
): void {
  pi.on("context", (event) => {
    const e = event as { messages: unknown[] };
    const filtered = e.messages.filter((m: unknown) => {
      const msg = m as { role?: string; customType?: string };
      return !(msg.role === "custom" && msg.customType === TEAMMATE_EVENT_CUSTOM_TYPE);
    });
    return { messages: filtered as never };
  });
}
