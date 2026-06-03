import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTeammateEventContextFilter } from "./eventEmit.js";
import { attachTeammateHandle, type TeammateHandle } from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";

export default function teammateExtension(pi: ExtensionAPI): void {
  const teamStore = createTeamStore();
  const mailbox = createMailbox();
  const handle: TeammateHandle = { teamStore, mailbox };
  attachTeammateHandle(pi, handle);

  installTeammateEventContextFilter(pi);

  pi.on("session_start", () => {
    // wired in later tasks
  });

  pi.on("session_shutdown", async () => {
    teamStore._resetForTest();
    mailbox._resetForTest();
  });
}
