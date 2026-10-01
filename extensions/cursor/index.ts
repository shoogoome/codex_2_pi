import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCursorProvider, CURSOR_ENGINE_VERSION } from "./provider.js";
import { cleanupAllSessionState, cleanupSessionState } from "./vendor/stream/session-state.js";
import { formatCursorUsage } from "./usage.js";

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
    description: "Cursor provider: /cursor [status|models|refresh|usage]",
    getArgumentCompletions: (prefix) => ["status", "models", "refresh", "usage"]
      .filter((action) => action.startsWith(prefix))
      .map((action) => ({ value: action, label: action })),
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "usage") {
        let text: string;
        let level: "info" | "error" = "info";
        try {
          text = formatCursorUsage(await runtime.usage(
            () => ctx.modelRegistry.getApiKeyForProvider("cursor"), ctx.signal,
          ));
        } catch (error) {
          const lifetimeAbort = error instanceof Error && error.name === "AbortError" && !ctx.signal?.aborted;
          if (lifetimeAbort) return; // The owning session may already have been replaced.
          const aborted = ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError");
          text = aborted ? "Cursor 用量查询已取消。" : error instanceof Error ? error.message : "Cursor 用量查询失败。";
          level = aborted ? "info" : "error";
        }
        // Shutdown/reload may invalidate this command's captured context while it awaited I/O.
        if (!runtime.isActive()) return;
        if (ctx.hasUI) ctx.ui.notify(text, level);
        else console.log(text);
        return;
      }
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
            "Pi token/cost 为估算；/cursor usage 查询服务端账单用量，计费以 Cursor 为准。",
          ].join("\n")
          : "用法：/cursor [status|models|refresh|usage]；登录：/login cursor；选择模型：/model cursor";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
