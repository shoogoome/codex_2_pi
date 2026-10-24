import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadWebFetchConfig, isSearchEnabled } from "./src/config.js";
import { createWebFetchTool } from "./src/tool.js";

/**
 * webfetch — port of Claude Code's WebFetch, extended with DeepSeek web search.
 *
 * Registers a single read-only, concurrency-safe `webfetch` tool that either
 * fetches a public URL as markdown or runs a web search (DeepSeek Search API) and
 * returns ranked results. Gated by the `--webfetch` flag (default on); when
 * disabled the tool is removed from the active set at session start.
 *
 * The tool is registered once and reads configuration through the shared helper,
 * so `/webfetch status|reload` can refresh it without a restart.
 */
export default function webfetchExtension(pi: ExtensionAPI): void {
  pi.registerFlag("webfetch", {
    description: "Enable the webfetch tool (fetch public web pages / search the web). Default on; --webfetch=false to disable.",
    type: "boolean",
    default: true,
  });

  let tool = createWebFetchTool();

  pi.registerTool({
    ...tool,
    execute: (toolCallId, params, signal, onUpdate, ctx) => tool.execute(toolCallId, params, signal, onUpdate, ctx),
  });

  pi.registerCommand("webfetch", {
    description: "Show or reload webfetch configuration (search on/off, page fallback mode)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (action === "reload") {
        tool = createWebFetchTool();
        ctx.ui.notify("webfetch: configuration reloaded from the environment.", "info");
        return;
      }
      if (action !== "" && action !== "status") {
        ctx.ui.notify("用法: /webfetch [status|reload]", "warning");
        return;
      }

      const config = loadWebFetchConfig();
      const search = isSearchEnabled(config) ? `on (${config.deepseekBaseUrl}, count=${config.searchCount})` : "off (未设置 DEEPSEEK_API_KEY)";
      const lines = [
        `search: ${search}`,
        `page extraction: local${config.deepseekFetch === "off" ? "" : ` + DeepSeek Fetch (${config.deepseekFetch})`}`,
        `limits: ${config.maxBytes} bytes / ${config.maxChars} chars / cache ${config.cacheMs}ms`,
      ];
      ctx.ui.notify(`webfetch\n${lines.join("\n")}`, "info");
    },
  });

  // Flag CLI values are only bound after registration, so gate at session start
  // (same pattern as localshell disabling the built-in bash tool).
  pi.on("session_start", () => {
    if (pi.getFlag("webfetch") === false) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((name) => name !== "webfetch"));
    }
  });
}
