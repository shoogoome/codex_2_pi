import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentRegistry } from "./registry.js";
import { createRpcClientFromProcess, spawnRpcProcess } from "./rpc-client.js";
import { createSubagentTools } from "./tools.js";
import { DEFAULT_SUBAGENT_OPTIONS, type SubagentRpcFactory, type SubagentToolDetails } from "./types.js";
import { renderSubagentResult } from "./render.js";
import { formatRunningSubagentWidget } from "./status-widget.js";

const RUNNING_WIDGET_KEY = "codex-subagents-running";
const RUNNING_WIDGET_REFRESH_MS = 1_000;

interface SubagentsExtensionDeps {
  registryFactory?: () => SubagentRegistry;
}

export default function subagentsExtension(pi: ExtensionAPI, deps: SubagentsExtensionDeps = {}) {
  const registry = deps.registryFactory?.() ?? new SubagentRegistry(DEFAULT_SUBAGENT_OPTIONS);
  let unsubscribeWidget: (() => void) | undefined;
  let widgetContext: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const rpcFactory: SubagentRpcFactory = {
    spawn(input) {
      const entry = registry.resolve(input.taskName);
      if (!entry) throw new Error(`subagent not found after create: ${input.taskName}`);
      const proc = spawnRpcProcess(input.cwd, input.model, input.sessionPath);
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

  pi.on("session_start", async (_event, ctx) => {
    widgetContext = ctx;
    unsubscribeWidget?.();
    unsubscribeWidget = registry.subscribe((summaries) => {
      updateRunningWidget(widgetContext, summaries);
    });
    stopRefreshTimer();
    if (ctx.hasUI) {
      refreshTimer = setInterval(() => {
        updateRunningWidget(widgetContext, registry.list());
      }, RUNNING_WIDGET_REFRESH_MS);
    }
  });

  pi.on("session_shutdown", async () => {
    stopRefreshTimer();
    unsubscribeWidget?.();
    unsubscribeWidget = undefined;
    clearRunningWidget(widgetContext);
    widgetContext = undefined;
    registry.closeAll();
  });

  function stopRefreshTimer(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }
}

function updateRunningWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, summaries: Parameters<typeof formatRunningSubagentWidget>[0]): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setWidget(RUNNING_WIDGET_KEY, formatRunningSubagentWidget(summaries), { placement: "belowEditor" });
}

function clearRunningWidget(ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined): void {
  if (!ctx?.hasUI) return;
  ctx.ui.setWidget(RUNNING_WIDGET_KEY, undefined, { placement: "belowEditor" });
}
