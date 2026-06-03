import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function teammateExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    // wired in later tasks
  });
  pi.on("session_shutdown", async () => {
    // wired in later tasks
  });
}
