#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const exec = promisify(execFile);
// Capture the launch pane. Never fall back to whichever window is currently focused.
const pane = process.env.TMUX_PANE;
const socket = process.env.TMUX?.split(",")[0];
const server = new Server(
  { name: "tmux-title", version: "0.1.0" },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "set_title",
    description: "每次开始用户任务前，先直接调用本工具，用 6–20 个汉字概括任务并设置 tmux 窗口标题，再执行其他工作；任务主题明显变化时更新，普通进度变化不重复调用。无需读取 Skill 或通过 codemode 调用。后台 worker 跳过；不可用或失败时继续主任务，不反复重试、不用 shell 绕过。只修改启动 Pi 的窗格所属窗口，不执行 shell、不操作其他窗口；改名会关闭该窗口的 automatic-rename。标题不要包含敏感信息。",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", minLength: 1, maxLength: 80, description: "简短、具体的任务标题，不含控制字符或敏感信息" } },
      required: ["title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name !== "set_title") throw new Error("Unknown tool");
    const args = request.params.arguments;
    if (!args || Object.keys(args).some((key) => key !== "title") ||
        typeof args.title !== "string" || !args.title.trim() ||
        Array.from(args.title).length > 80 || /[\x00-\x1f\x7f-\x9f]/u.test(args.title)) {
      throw new Error("title must be 1–80 characters, non-blank, without control characters");
    }
    if (!socket || !pane || !/^%\d+$/.test(pane)) {
      throw new Error("Not running in tmux: TMUX and TMUX_PANE are required; no window was changed");
    }
    const run = (args) => exec("tmux", ["-S", socket, ...args], {
      timeout: 5000, maxBuffer: 16 * 1024, encoding: "utf8",
    });
    const { stdout } = await run(["display-message", "-p", "-t", pane, "#{window_id}"]);
    const window = stdout.trim();
    if (!/^@\d+$/.test(window)) throw new Error("Could not resolve the launch pane's window");
    const title = args.title.trim();
    await run(["rename-window", "-t", window, "--", title]);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, window, title }) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

await server.connect(new StdioServerTransport());
