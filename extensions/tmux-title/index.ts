import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The workspace's older Pi declarations predate the native MCP registrar.
interface McpRegistrar {
  registerMcpServer(name: string, config: {
    command: string;
    args: string[];
    env: Record<string, string>;
    exposure: "direct";
    description: string;
  }): void;
}

export default function tmuxTitleExtension(pi: ExtensionAPI): void {
  if (!process.env.TMUX || !/^%\d+$/.test(process.env.TMUX_PANE ?? "")) return;
  const registrar = pi as unknown as Partial<McpRegistrar>;
  if (typeof registrar.registerMcpServer !== "function") return;

  registrar.registerMcpServer("tmux_title", {
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    env: { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE! },
    exposure: "direct",
    description: "工作前调用 set_title，以任务摘要更新启动 Pi 所在的 tmux 窗口标题。",
  });
}
