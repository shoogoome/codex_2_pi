import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebFetchTool } from "./src/tool.js";

/**
 * webfetch — port of Claude Code's WebFetch as a pi extension.
 *
 * Registers a single read-only, concurrency-safe `webfetch` tool that fetches a
 * public URL and returns it as markdown. Gated by the `--webfetch` flag (default
 * on); when disabled the tool is removed from the active set at session start.
 * Approval is handled by pi's standard tool-approval flow — the tool description
 * surfaces the target domain so an approvals rule can key on it later.
 */
export default function webfetchExtension(pi: ExtensionAPI): void {
  pi.registerFlag("webfetch", {
    description: "Enable the webfetch tool (fetch public web pages to markdown). Default on; --webfetch=false to disable.",
    type: "boolean",
    default: true,
  });

  pi.registerTool(createWebFetchTool());

  // Flag CLI values are only bound after registration, so gate at session start
  // (same pattern as localshell disabling the built-in bash tool).
  pi.on("session_start", () => {
    if (pi.getFlag("webfetch") === false) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((name) => name !== "webfetch"));
    }
  });
}
