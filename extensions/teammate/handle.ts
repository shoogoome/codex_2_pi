// Cross-extension handle for teammate state.
//
// Pi loads each extension under its own jiti module realm, so extensions
// can't share singletons via simple module-level exports. Instead we attach
// the handle on `pi.events` — a per-session bus that all extensions reach
// the same instance of.
//
// Pattern mirrors `extensions/tasks/handle.ts`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TeamStore } from "./teamStore.js";
import type { Mailbox } from "./mailbox.js";
import type { TeamTaskStore } from "./teamTasks/teamTaskStore.js";

export interface TeammateHandle {
  teamStore: TeamStore;
  mailbox: Mailbox;
  teamTaskStore: TeamTaskStore;
}

const HANDLE_KEY = "teammate";

interface PiWithEvents {
  events: Record<string, unknown>;
}

export function attachTeammateHandle(pi: ExtensionAPI, handle: TeammateHandle): void {
  const p = pi as unknown as PiWithEvents;
  p.events[HANDLE_KEY] = handle;
}

export function getTeammateHandle(pi: ExtensionAPI): TeammateHandle {
  const p = pi as unknown as PiWithEvents;
  const handle = p.events[HANDLE_KEY] as TeammateHandle | undefined;
  if (!handle) {
    throw new Error(
      "teammate: default TeammateHandle not initialised. Ensure pi-teammate-extension is loaded before any extension that uses it.",
    );
  }
  return handle;
}
