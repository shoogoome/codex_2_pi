import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentRegistry } from "./registry.js";
import { createRpcClientFromProcess, spawnRpcProcess } from "./rpc-client.js";
import { createSubagentTools } from "./tools.js";
import { DEFAULT_SUBAGENT_OPTIONS, type SubagentRpcFactory, type SubagentToolDetails } from "./types.js";
import { renderSubagentResult } from "./render.js";

export default function subagentsExtension(pi: ExtensionAPI) {
  const registry = new SubagentRegistry(DEFAULT_SUBAGENT_OPTIONS);
  const rpcFactory: SubagentRpcFactory = {
    spawn(input) {
      const entry = registry.resolve(input.taskName);
      if (!entry) throw new Error(`subagent not found after create: ${input.taskName}`);
      const proc = spawnRpcProcess(input.cwd, input.model);
      return createRpcClientFromProcess(entry.id, input.taskName, proc, registry);
    },
  };

  for (const tool of createSubagentTools(registry, rpcFactory)) {
    pi.registerTool(tool);
  }

  pi.registerMessageRenderer("codex-subagent-update", (message, { expanded }, theme) => {
    const text = typeof message.content === "string" ? message.content : "";
    const result = {
      content: [{ type: "text" as const, text }],
      details: message.details as SubagentToolDetails,
    };
    return renderSubagentResult(result, expanded, theme);
  });

  pi.on("session_shutdown", async () => {
    registry.closeAll();
  });
}
