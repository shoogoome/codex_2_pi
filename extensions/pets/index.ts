import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function petsExtension(pi: ExtensionAPI): Promise<void> {
  pi.registerCommand("pets", {
    description: "Configure the Codex-style terminal pet (stub).",
    handler: async () => {
      // Implemented in later tasks.
    },
  });

  pi.on("session_start", async () => {
    // Implemented in later tasks.
  });

  pi.on("session_shutdown", async () => {
    // Implemented in later tasks.
  });
}
