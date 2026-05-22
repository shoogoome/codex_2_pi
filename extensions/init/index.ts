import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildInitPrompt } from "./init-prompt.js";

const AGENTS_FILE = "AGENTS.md";

export default function initExtension(pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Create an AGENTS.md file with project instructions",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Run /init when idle.", "warning");
        return;
      }

      const target = join(ctx.cwd, AGENTS_FILE);
      if (existsSync(target)) {
        ctx.ui.notify("AGENTS.md already exists here. Skipping /init to avoid overwriting it.", "info");
        return;
      }

      pi.sendUserMessage(buildInitPrompt());
    },
  });
}
