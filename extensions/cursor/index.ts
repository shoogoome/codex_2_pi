import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCursorProvider, CURSOR_ENGINE_VERSION } from "./provider.js";
import { cleanupAllSessionState, cleanupSessionState } from "./vendor/stream/session-state.js";

export default function cursorExtension(pi: ExtensionAPI): void {
  pi.registerFlag("cursor", {
    description: "Enable the native Cursor subscription provider",
    type: "boolean",
    default: true,
  });
  if (pi.getFlag("cursor") === false) return;

  const runtime = createCursorProvider();
  pi.registerProvider(runtime.provider);
  pi.on("session_start", () => runtime.start());

  const cleanupSession = (_event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => {
    cleanupSessionState(ctx.sessionManager.getSessionId());
  };
  pi.on("session_before_switch", cleanupSession);
  pi.on("session_before_fork", cleanupSession);
  pi.on("session_before_tree", cleanupSession);
  pi.on("session_compact", cleanupSession);
  pi.on("session_shutdown", () => {
    runtime.stop();
    cleanupAllSessionState();
  });

  pi.registerCommand("cursor", {
    description: "Cursor provider: /cursor [status|models|refresh]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "refresh") {
        const result = await ctx.modelRegistry.refresh({ providers: ["cursor"], force: true, signal: ctx.signal });
        const text = result.errors.has("cursor") || result.aborted
          ? "Cursor 模型刷新失败或已取消，请检查登录和网络。"
          : runtime.catalogSource() === "live" ? "Cursor 实时模型目录已刷新。" : "尚未取得实时目录，请先 /login cursor。";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else console.log(text);
        return;
      }
      const text = action === "models"
        ? runtime.provider.getModels().map((m) => `${m.id}  ${m.name}`).join("\n")
        : action === "status"
          ? [
            `Cursor native provider · protocol core ${CURSOR_ENGINE_VERSION}`,
            `endpoint: ${runtime.provider.baseUrl}`,
            `models: ${runtime.provider.getModels().length} (${runtime.catalogSource()} catalog)`,
            "认证：/login cursor；模型：/model cursor；不读取 Keychain/IDE 登录态。",
            "工具由 Pi 执行；Cursor 原生文件、Shell、fetch 和联网自动批准已禁用。",
            "用量/成本为估算，订阅额度与计费以 Cursor 为准。",
          ].join("\n")
          : "用法：/cursor [status|models|refresh]；登录：/login cursor；选择模型：/model cursor";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
