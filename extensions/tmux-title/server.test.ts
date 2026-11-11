import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const clients: Client[] = [];
async function connect(env: Record<string, string>) {
  const client = new Client({ name: "tmux-title-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [serverPath], env, stderr: "pipe",
  }));
  return client;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
function call(client: Client, title: unknown, extra = {}) {
  return client.callTool({ name: "set_title", arguments: { title, ...extra } });
}

describe("tmux title MCP protocol", () => {
  it("advertises one bounded, idempotent title tool", async () => {
    const client = await connect({ TMUX: "", TMUX_PANE: "" });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "set_title",
      description: expect.stringContaining("每次开始用户任务前，先直接调用本工具"),
      inputSchema: { additionalProperties: false, required: ["title"] },
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
    });
  });

  it("rejects invalid titles, unknown tools and arbitrary targets", async () => {
    const client = await connect({ TMUX: "", TMUX_PANE: "" });
    for (const title of ["", "  ", "a\nb", "\u001b[0m", "\u009b", "字".repeat(81), null, 7]) {
      expect(await call(client, title)).toMatchObject({ isError: true });
    }
    expect(await call(client, "标题", { target: "@1" })).toMatchObject({ isError: true });
    expect(await client.callTool({ name: "other", arguments: {} })).toMatchObject({ isError: true });
  });

  it("returns an explicit error without tmux or on a missing socket", async () => {
    const client = await connect({ TMUX: "", TMUX_PANE: "" });
    expect(await call(client, "任务标题")).toMatchObject({
      isError: true, content: [{ type: "text", text: expect.stringContaining("Not running in tmux") }],
    });
    const broken = await connect({ TMUX: "/nonexistent/pi-tmux-title/socket,1,0", TMUX_PANE: "%0" });
    expect(await call(broken, "任务标题")).toMatchObject({ isError: true });
  });
});

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional platform dependency */ }

describe.skipIf(!hasTmux)("isolated real tmux acceptance", () => {
  it("renames only the pinned window even when another window is selected, without shell execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-title-"));
    const socket = join(dir, "sock");
    const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
    try {
      tmux("-f", "/dev/null", "new-session", "-d", "-s", "test", "-n", "original");
      const pane = tmux("display-message", "-p", "-t", "test:0", "#{pane_id}");
      tmux("new-window", "-t", "test:", "-n", "other");
      tmux("set-window-option", "-t", "test:1", "automatic-rename", "off");
      const client = await connect({ TMUX: socket + ",1,0", TMUX_PANE: pane });
      const marker = join(dir, "injected");
      const title = "-任务; $(touch " + marker + ")";
      const result = await call(client, title);
      expect(result.isError).not.toBe(true);
      expect(tmux("display-message", "-p", "-t", "test:0", "#{window_name}")).toBe(title);
      expect(tmux("display-message", "-p", "-t", "test:1", "#{window_name}")).toBe("other");
      expect(tmux("show-window-options", "-t", "test:0", "automatic-rename")).toBe("automatic-rename off");
      expect(existsSync(marker)).toBe(false);
      expect((await call(client, title)).isError).not.toBe(true);
      tmux("kill-window", "-t", "test:0");
      expect(await call(client, "已消失窗口")).toMatchObject({ isError: true });
      expect(tmux("display-message", "-p", "-t", "test:1", "#{window_name}")).toBe("other");
    } finally {
      try { tmux("kill-server"); } catch { /* already stopped */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
