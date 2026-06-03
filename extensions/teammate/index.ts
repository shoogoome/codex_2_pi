import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installTeammateEventContextFilter } from "./eventEmit.js";

export default function teammateExtension(pi: ExtensionAPI): void {
  installTeammateEventContextFilter(pi);

  pi.on("session_start", () => {
    // wired in later tasks
  });
  pi.on("session_shutdown", async () => {
    // wired in later tasks
  });
}
