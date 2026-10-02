import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ContextPanel } from "./panel.js";
import { buildSections } from "./sections.js";

export default function contextViewerExtension(pi: ExtensionAPI): void {
  async function open(ctx: ExtensionCommandContext, systemOnly: boolean): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("上下文查看器需要 TUI 模式。", "warning");
      return;
    }
    const sections = buildSections(
      ctx.getSystemPrompt(),
      systemOnly ? [] : ctx.sessionManager.buildContextEntries(),
    );
    await ctx.ui.custom<void>((tui, theme, _keys, done) => new ContextPanel(
      sections, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(),
    ), { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } });
  }

  pi.registerCommand("context", {
    description: "查看当前系统提示词与隐藏注入上下文（不含聊天历史）",
    handler: async (_args, ctx) => open(ctx, false),
  });
  pi.registerCommand("system-prompt", {
    description: "只查看当前有效系统提示词",
    handler: async (_args, ctx) => open(ctx, true),
  });
}
