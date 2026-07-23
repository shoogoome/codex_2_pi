import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadSettingsEnv } from "./src/settingsEnv.js";

export default function settingsEnvExtension(pi: ExtensionAPI): void {
  const load = (cwd: string): void => {
    const result = loadSettingsEnv({
      cwd,
      agentDir: getAgentDir(),
    });

    for (const warning of result.warnings) {
      console.error(`[settings-env] ${warning}`);
    }
  };

  // Load immediately so extensions initialized after this one can consume env.
  load(process.cwd());

  // `/reload` re-emits session_start without recreating extension modules. Load
  // settings again before plugin-loader's async session_start handler resumes and
  // reconnects runtime MCP servers.
  pi.on("session_start", (_event, ctx) => {
    load(ctx.cwd);
  });
}
