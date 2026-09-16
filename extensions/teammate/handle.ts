// Cross-extension handle for teammate state.
//
// Pi loads each extension under its own jiti module realm, so extensions
// can't share singletons via simple module-level exports. Pi 0.84+ also
// gives each extension its own `pi.events` facade; attachSessionHandle
// publishes on the shared EventBus so localagent can resolve this handle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachSessionHandle, getSessionHandle } from "../shared/sessionHandle.js";
import type { TeamStore } from "./teamStore.js";
import type { Mailbox } from "./mailbox.js";
import type { TeamTaskStore } from "./teamTasks/teamTaskStore.js";

export interface TeammateHandle {
  teamStore: TeamStore;
  mailbox: Mailbox;
  teamTaskStore: TeamTaskStore;
}

const HANDLE_KEY = "teammate";

export function attachTeammateHandle(pi: ExtensionAPI, handle: TeammateHandle): void {
  attachSessionHandle(pi, HANDLE_KEY, handle);
}

export function getTeammateHandle(pi: ExtensionAPI): TeammateHandle {
  const handle = getSessionHandle<TeammateHandle>(pi, HANDLE_KEY);
  if (!handle) {
    throw new Error(
      "teammate: default TeammateHandle not initialised. Ensure pi-teammate-extension is loaded before any extension that uses it.",
    );
  }
  return handle;
}
