// hydrate — rebuild teammate state from a list of session entries.
//
// Pi exposes the parent session jsonl via ctx.sessionManager.getEntries(). We
// filter to entries that are custom messages with our customType, extract
// each one's details as a TeammateEvent, and feed them through the reducer.
//
// Defensive: malformed entries (no details, details not object, no kind field
// or non-string kind) are silently skipped. This keeps hydration robust even
// if a future code path emits a partial event.
//
// Task 4.2 wraps this with the actual respawn flow (calling SessionManager.open
// for each running teammate). Task 4.3 wires it into session_start.

import { TEAMMATE_EVENT_CUSTOM_TYPE } from "./eventEmit.js";
import {
  reduceTeammateEvents,
  type ReplayedState,
} from "./jsonlEvents.js";
import type { TeammateEvent } from "./types.js";

export interface SessionEntryLike {
  type: string;
  customType?: string;
  details?: unknown;
}

export function hydrateTeammateState(
  entries: readonly SessionEntryLike[],
): ReplayedState {
  const events: TeammateEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    if (entry.customType !== TEAMMATE_EVENT_CUSTOM_TYPE) continue;
    const details = entry.details;
    if (typeof details !== "object" || details === null) continue;
    const obj = details as Record<string, unknown>;
    if (typeof obj.kind !== "string") continue;
    events.push(details as TeammateEvent);
  }
  return reduceTeammateEvents(events);
}
