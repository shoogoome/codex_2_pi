import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDotsChannelServer } from "./src/dotsServer.js";
import { installChannelExtension } from "./index.js";
import { createChannelDefinition, saveChannelSettings } from "./src/store.js";
import { WechatImageCaptionError } from "./src/wechat.js";

interface Harness {
  pi: Record<string, unknown>;
  handlers: Map<string, (event: unknown, ctx: any) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: any) => unknown }>;
  tools: Map<string, { execute: (...args: any[]) => unknown }>;
  sendMessage: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  ctx: any;
}

function buildHarness(sessionId = "session-1", sessionName = "发布会话"): Harness {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const defaults = new Map<string, boolean | string | undefined>();
  const tools = new Map<string, { execute: (...args: any[]) => unknown }>();
  const sendMessage = vi.fn();
  const notify = vi.fn();
  const select = vi.fn(async (_title: string, options: string[]) => options.at(-1));
  const pi = {
    registerFlag(name: string, options: { default?: boolean | string }) {
      defaults.set(name, options.default);
    },
    getFlag(name: string) {
      return defaults.get(name);
    },
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, command);
    },
    registerTool(tool: { name: string; execute: (...args: any[]) => unknown }) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer: vi.fn(),
    sendMessage,
  };
  const ctx = {
    cwd: "/repo",
    hasUI: true,
    ui: { notify, select, setStatus: vi.fn() },
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => sessionName },
  };
  return { pi, handlers, commands, tools, sendMessage, notify, select, ctx };
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("channel extension entrypoint", () => {
  it("registers lifecycle, command, renderer, and remains quiet without a token", async () => {
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, { env: {}, agentDir: "/unused" });

    expect(harness.handlers.has("session_start")).toBe(true);
    expect(harness.handlers.has("session_shutdown")).toBe(true);
    expect(harness.commands.has("channel")).toBe(true);

    await harness.handlers.get("session_start")!({}, harness.ctx);
    expect(harness.notify).not.toHaveBeenCalled();

    await harness.commands.get("channel")!.handler("status", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("PI_CHANNEL_TOKEN is not configured"),
      "info",
    );
  });

  it("exposes named outbound channels to Pi and routes channel_send by name", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-"));
    tempRoots.push(agentDir);
    const outbound = createChannelDefinition({
      name: "产物群",
      protocol: "http",
      direction: "outbound",
      scope: "all",
      sessionId: "session-1",
      http: { callbackUrl: "https://example.com/callback" },
    });
    await saveChannelSettings(agentDir, { version: 1, channels: [outbound] });
    const sendHttp = vi.fn(async () => undefined);
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, { env: {}, agentDir, sendHttp });

    await harness.handlers.get("session_start")!({}, harness.ctx);
    const registry = await harness.handlers.get("before_agent_start")!({}, harness.ctx) as {
      message?: { content?: string };
    };
    expect(registry.message?.content).toContain('name="产物群"');
    expect(registry.message?.content).toContain("发布会话");

    const result = await harness.tools.get("channel_send")!.execute(
      "call-1",
      { channel: "产物群", content: "阶段产物" },
      undefined,
      undefined,
      harness.ctx,
    ) as { details: { delivered: boolean } };
    expect(result.details.delivered).toBe(true);
    expect(sendHttp).toHaveBeenCalledWith(
      expect.objectContaining({ name: "产物群" }),
      expect.objectContaining({
        content: "阶段产物",
        session: expect.objectContaining({ id: "session-1", name: "发布会话" }),
      }),
    );
  });

  it("routes local image paths to WeChat, preserves direction checks and rejects unsupported channels", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-send-image-"));
    tempRoots.push(agentDir);
    const wechat = createChannelDefinition({ name: "wx", protocol: "wechat", direction: "outbound", scope: "all", sessionId: "session-1" });
    const http = createChannelDefinition({ name: "http", protocol: "http", direction: "outbound", scope: "all", sessionId: "session-1", http: { callbackUrl: "https://example.com/callback" } });
    const inbound = createChannelDefinition({ name: "inbound", protocol: "wechat", direction: "inbound", scope: "all", sessionId: "session-1" });
    await saveChannelSettings(agentDir, { version: 1, channels: [wechat, http, inbound] });
    const sendImage = vi.fn(async () => undefined);
    const send = vi.fn(async () => undefined);
    const sendHttp = vi.fn(async () => undefined);
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, {
      env: {}, agentDir, sendHttp,
      startWechat: async () => ({ status: "occupied", send, sendImage, close: async () => undefined }),
      startRelay: async () => ({ publish: async () => undefined, close: async () => undefined }),
    });
    await harness.handlers.get("session_start")!({}, harness.ctx);
    const tool = harness.tools.get("channel_send")!;
    const abort = new AbortController();
    const result = await tool.execute("image", { channel: "wx", image_path: "output/chart.png" }, abort.signal) as any;
    expect(result.details.delivered).toBe(true);
    expect(sendImage).toHaveBeenCalledWith("/repo/output/chart.png", undefined, "", abort.signal);
    await tool.execute("caption", { channel: "wx", image_path: "/tmp/image.png", content: "图表" });
    expect(sendImage).toHaveBeenLastCalledWith("/tmp/image.png", undefined, "图表", undefined);
    expect(send).not.toHaveBeenCalled();
    for (const params of [
      { channel: "http", image_path: "image.png" },
      { channel: "inbound", image_path: "image.png" },
      { channel: "wx", content: " " },
      { channel: "wx", image_path: "image.png", message_id: "id" },
    ]) {
      const failed = await tool.execute("invalid", params) as any;
      expect(failed.details.delivered).toBe(false);
    }
    expect(sendHttp).not.toHaveBeenCalled();
    expect(sendImage).toHaveBeenCalledTimes(2);
    sendImage.mockRejectedValueOnce(new Error("upload failed"));
    const failed = await tool.execute("failure", { channel: "wx", image_path: "image.png" }) as any;
    expect(failed.details).toMatchObject({ delivered: false, error: "upload failed" });
    sendImage.mockRejectedValueOnce(new WechatImageCaptionError(new Error("caption failed")));
    const partial = await tool.execute("partial", { channel: "wx", image_path: "image.png", content: "说明" }) as any;
    expect(partial.details).toMatchObject({ delivered: false, imageDelivered: true, error: expect.stringContaining("图片已发送") });
    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
  });

  it("enforces the current session's direction override in registry and channel_send", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-"));
    tempRoots.push(agentDir);
    const channel = createChannelDefinition({
      name: "共享通知",
      protocol: "http",
      direction: "both",
      scope: "selected",
      sessionId: "session-a",
      http: { token: "secret", callbackUrl: "https://example.com/callback" },
    });
    channel.sessionDirections = { "session-a": "inbound", "session-b": "outbound" };
    channel.scope.sessionIds.push("session-b");
    await saveChannelSettings(agentDir, { version: 1, channels: [channel] });
    const sendHttp = vi.fn(async () => undefined);
    const harness = buildHarness("session-a", "会话 A");
    installChannelExtension(harness.pi as never, { env: {}, agentDir, sendHttp });

    await harness.handlers.get("session_start")!({}, harness.ctx);
    const registry = await harness.handlers.get("before_agent_start")!({}, harness.ctx) as {
      message?: { content?: string };
    };
    expect(registry.message?.content).toContain("direction=inbound");
    const result = await harness.tools.get("channel_send")!.execute(
      "call-direction",
      { channel: "共享通知", content: "不应发送" },
      undefined,
      undefined,
      harness.ctx,
    ) as { details: { delivered: boolean; error?: string } };
    expect(result.details).toMatchObject({
      delivered: false,
      error: expect.stringContaining("inbound-only in this session"),
    });
    expect(sendHttp).not.toHaveBeenCalled();
    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
  });

  it("routes generic /channel auth through the registered protocol auth adapter", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-"));
    tempRoots.push(agentDir);
    const harness = buildHarness();
    const loginWechat = vi.fn(async () => ({
      token: "bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "bot",
      userId: "user",
      savedAt: new Date().toISOString(),
    }));
    const startWechat = vi.fn(async () => ({
      status: "connected" as const,
      send: async () => undefined,
      close: async () => undefined,
    }));
    installChannelExtension(harness.pi as never, {
      env: {},
      agentDir,
      loginWechat,
      startWechat,
    });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    await harness.commands.get("channel")!.handler("auth", harness.ctx);
    expect(harness.select).toHaveBeenCalledWith(
      "选择要登录/认证的 Channel",
      [expect.stringContaining("微信 ClawBot")],
    );
    expect(loginWechat).toHaveBeenCalledWith(
      agentDir,
      expect.objectContaining({
        name: "微信",
        protocol: "wechat",
        direction: "both",
        scope: { kind: "selected", sessionIds: ["session-1"] },
        sessionDirections: { "session-1": "both" },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const config = JSON.parse(await readFile(join(agentDir, "channel", "config.json"), "utf8"));
    expect(config.channels).toHaveLength(1);
    expect(config.channels[0]).toMatchObject({ name: "微信", protocol: "wechat", direction: "both" });
  });

  it("forwards WeChat image blocks through the Channel envelope and relay", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-image-"));
    tempRoots.push(agentDir);
    const wechat = createChannelDefinition({
      name: "图片微信",
      protocol: "wechat",
      direction: "both",
      scope: "selected",
      sessionId: "session-1",
    });
    await saveChannelSettings(agentDir, { version: 1, channels: [wechat] });
    let receiveWechat: ((message: any) => Promise<void>) | undefined;
    const publish = vi.fn(async () => undefined);
    const startWechat = vi.fn(async (options: any) => {
      receiveWechat = options.onMessage;
      return {
        status: "connected" as const,
        send: async () => undefined,
        close: async () => undefined,
      };
    });
    const startRelay = vi.fn(async () => ({
      publish,
      close: async () => undefined,
    }));
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, {
      env: {},
      agentDir,
      startWechat,
      startRelay,
    });

    await harness.handlers.get("session_start")!({}, harness.ctx);
    await receiveWechat?.({
      id: "wx-image-1",
      userId: "wx-user-1",
      content: "用户通过微信发送了一张图片，请分析图片内容。",
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      receivedAt: "2026-08-13T00:00:00.000Z",
    });

    const sent = harness.sendMessage.mock.calls.at(-1)?.[0];
    expect(sent).toMatchObject({
      customType: "channel/message",
      display: true,
      content: [
        { type: "text", text: expect.stringContaining("用户通过微信发送了一张图片") },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      id: "wx-image-1",
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    }));
    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
  });

  it("enforces a bidirectional HTTP channel and routes its assistant reply to the callback", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-"));
    tempRoots.push(agentDir);
    const bidirectional = createChannelDefinition({
      name: "发布群",
      protocol: "http",
      direction: "both",
      scope: "selected",
      sessionId: "session-1",
      http: {
        token: "inbound-secret",
        callbackUrl: "https://example.com/reply",
      },
    });
    await saveChannelSettings(agentDir, { version: 1, channels: [bidirectional] });
    const sendHttp = vi.fn(async () => undefined);
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, { env: {}, agentDir, sendHttp });
    await harness.handlers.get("session_start")!({}, harness.ctx);

    const files = await readdir(join(agentDir, "channels"));
    const discovery = JSON.parse(await readFile(join(agentDir, "channels", files[0]!), "utf8")) as { port: number };
    const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer inbound-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "release-bot", content: "进度如何？" }),
    });
    expect(response.status).toBe(202);

    await harness.handlers.get("agent_start")!({}, harness.ctx);
    await harness.handlers.get("message_end")!({
      message: { role: "assistant", content: [{ type: "text", text: "阶段一已完成" }] },
    }, harness.ctx);
    expect(sendHttp).toHaveBeenCalledWith(
      expect.objectContaining({ name: "发布群" }),
      expect.objectContaining({ content: "阶段一已完成" }),
    );
    await harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
  });

  it("accepts HTTP input, injects it into Pi, writes discovery, and cleans up", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-index-"));
    tempRoots.push(agentDir);
    const harness = buildHarness();
    installChannelExtension(harness.pi as never, {
      env: {
        PI_CHANNEL_TOKEN: "integration-token",
        PI_CHANNEL_HOST: "127.0.0.1",
        PI_CHANNEL_PORT: "0",
      },
      agentDir,
    });

    await harness.handlers.get("session_start")!({}, harness.ctx);
    const files = await readdir(join(agentDir, "channels"));
    expect(files).toHaveLength(1);
    const discoveryPath = join(agentDir, "channels", files[0]!);
    const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as {
      port: number;
      sessionId: string;
    };
    expect(discovery.sessionId).toBe("session-1");

    const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer integration-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "external-1",
        source: "alertmanager",
        content: "Investigate this alert",
        delivery: "followUp",
        wake: true,
      }),
    });
    expect(response.status).toBe(202);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "channel/message",
        display: true,
        content: expect.stringContaining("Investigate this alert"),
      }),
      { deliverAs: "followUp", triggerTurn: true },
    );

    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
    expect(await readdir(join(agentDir, "channels"))).toEqual([]);
  });
});

describe("multi-protocol channel_manage", () => {
  async function setup(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-manage-"));
    tempRoots.push(agentDir);
    const harness = buildHarness();
    harness.ctx.hasUI = false;
    const close = vi.fn(async () => undefined);
    const startServer = vi.fn(async (options: any) => ({ host: options.host, port: options.port || 15432, close }));
    const startWechat = vi.fn(async () => ({ status: "connected", send: vi.fn(), close }));
    installChannelExtension(harness.pi as never, {
      env, agentDir, startServer: startServer as never, startWechat: startWechat as never,
      startRelay: async () => ({ publish: async () => undefined, close: vi.fn() }),
      ...extra,
    });
    await harness.handlers.get("session_start")!({}, harness.ctx);
    const manage = (params: any, signal?: AbortSignal, onUpdate?: any) => harness.tools.get("channel_manage")!.execute("t", params, signal, onUpdate, harness.ctx) as Promise<any>;
    const shutdown = () => harness.handlers.get("session_shutdown")!({}, harness.ctx);
    return { ...harness, agentDir, manage, startServer, startWechat, shutdown };
  }

  it("creates a bidirectional HTTP channel without TUI, persists settings and redacts secrets", async () => {
    const h = await setup();
    try {
      const created = await h.manage({ action: "create", protocol: "http", name: "dot-http", http: { callbackUrl: "https://example.com/reply?secret=hidden", callbackToken: "callback-secret" }, delivery: "followUp" });
      expect(created.details.result).toMatchObject({ saved: true, listenerToken: expect.any(String), channel: { protocol: "http", direction: "both", scope: { kind: "selected", sessionIds: ["session-1"] }, runtime: { status: "listening", port: 15432 } } });
      const persisted = JSON.parse(await readFile(join(h.agentDir, "channel/config.json"), "utf8"));
      expect(persisted.channels[0].http.token).toBe(created.details.result.listenerToken);
      expect(h.startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "127.0.0.1", port: 0, defaultDelivery: "followUp" }));
      for (const params of [{ action: "list" }, { action: "status", channel: "DOT-HTTP" }]) {
        const result = JSON.stringify(await h.manage(params));
        expect(result).not.toContain(created.details.result.listenerToken);
        expect(result).not.toContain("callback-secret");
        expect(result).not.toContain("secret=hidden");
      }
    } finally { await h.shutdown(); }
  });

  it("supports mount, unmount, per-session direction, enable/disable, restart and confirmed deletion", async () => {
    const h = await setup();
    try {
      await h.manage({ action: "create", protocol: "http", name: "notify", direction: "outbound", http: { callbackUrl: "https://example.com/reply" } });
      expect((await h.manage({ action: "unmount", channel: "notify" })).details.result.channel.runtime.mounted).toBe(false);
      expect((await h.manage({ action: "mount", channel: "notify" })).details.result.channel.runtime.mounted).toBe(true);
      await h.manage({ action: "update", channel: "notify", direction: "both", http: { token: "new-token" }, delivery: "nextTurn", wake: true });
      const status = (await h.manage({ action: "status", channel: "notify" })).details.result;
      expect(status).toMatchObject({ direction: "both", delivery: "nextTurn", wake: false });
      expect((await h.manage({ action: "disable", channel: "notify" })).details.result.channel.enabled).toBe(false);
      await h.manage({ action: "enable", channel: "notify" });
      await h.manage({ action: "create", protocol: "wechat", name: "unrelated" });
      const wechatStarts = h.startWechat.mock.calls.length;
      await h.manage({ action: "restart", channel: "notify" });
      expect(h.startWechat).toHaveBeenCalledTimes(wechatStarts);
      await h.manage({ action: "delete", channel: "unrelated", confirm: true });
      await expect(h.manage({ action: "delete", channel: "notify" })).rejects.toThrow("Invalid channel_manage");
      expect((await h.manage({ action: "delete", channel: "notify", confirm: true })).details.result.deleted).toBe(true);
      expect((await h.manage({ action: "list" })).details.result.channels).toEqual([]);
    } finally { await h.shutdown(); }
  });

  it("creates WeChat and reports authentication QR in non-UI mode without inventing login", async () => {
    const loginWechat = vi.fn(async (_dir, _channel, options) => { options.onQr("QR", "https://example.com/qr"); options.onStatus("confirmed"); });
    const h = await setup({}, { loginWechat });
    try {
      const created = await h.manage({ action: "create", protocol: "wechat", name: "wx" });
      expect(created.details.result.next).toContain("scan");
      expect(loginWechat).not.toHaveBeenCalled();
      const update = vi.fn();
      const result = await h.manage({ action: "auth", channel: "wx" }, undefined, update);
      expect(result.details.result.authenticated).toBe(true);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining("https://example.com/qr") }] }));
    } finally { await h.shutdown(); }
  });

  it("keeps Pi management usable when external settings become invalid", async () => {
    const h = await setup();
    try {
      const { writeFile } = await import("node:fs/promises");
      await h.manage({ action: "create", protocol: "wechat", name: "wx" });
      await writeFile(join(h.agentDir, "channel/config.json"), "broken json");
      await expect(h.manage({ action: "members", channel: "missing-pi" })).rejects.toThrow(/not found/i);
    } finally { await h.shutdown(); }
  });

  it("validates protocol configuration and collisions before saving", async () => {
    const h = await setup();
    try {
      await expect(h.manage({ action: "create", protocol: "http", name: "bad" })).rejects.toThrow("callbackUrl");
      await expect(h.manage({ action: "create", protocol: "wechat", name: "bad", http: {} })).rejects.toThrow("match protocol");
      await h.manage({ action: "create", protocol: "wechat", name: "wx" });
      await expect(h.manage({ action: "create", protocol: "wechat", name: "WX" })).rejects.toThrow("already exists");
      await expect(h.manage({ action: "update", channel: "wx", http: {} })).rejects.toThrow("match protocol");
      await expect(h.manage({ action: "create", protocol: "unknown", name: "bad" })).rejects.toThrow("Invalid channel_manage");
      expect((await h.manage({ action: "list" })).details.result.channels).toHaveLength(1);
    } finally { await h.shutdown(); }
  });

  it("keeps saved state distinct from listener startup failures and does not expose error secrets", async () => {
    const h = await setup({}, { startServer: async () => { throw new Error("private-token port busy"); } });
    try {
      const result = await h.manage({ action: "create", protocol: "http", name: "bad-port", direction: "inbound" });
      expect(result.details.result).toMatchObject({ saved: true, channel: { runtime: { status: "error" } } });
      expect(JSON.stringify(result)).not.toContain("private-token");
    } finally { await h.shutdown(); }
  });

  it("rejects disabled, cancelled and read-only legacy mutations", async () => {
    const disabled = await setup({ PI_CHANNEL: "0" });
    try { await expect(disabled.manage({ action: "create", protocol: "wechat", name: "wx" })).rejects.toThrow("disabled"); }
    finally { await disabled.shutdown(); }
    const h = await setup({ PI_CHANNEL_TOKEN: "secret" });
    try {
      await expect(h.manage({ action: "delete", channel: "legacy-http", confirm: true })).rejects.toThrow("read-only");
      const abort = new AbortController(); abort.abort();
      await expect(h.manage({ action: "create", protocol: "wechat", name: "wx" }, abort.signal)).rejects.toThrow("cancelled");
    } finally { await h.shutdown(); }
  });
});

describe("MCP Channel session exposure", () => {
  async function setup(direction = "both", additional: Record<string, unknown> = {}) {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-channel-mcp-index-"));
    tempRoots.push(agentDir);
    const h = buildHarness();
    h.ctx.hasUI = false;
    installChannelExtension(h.pi as never, { env: {}, agentDir });
    await h.handlers.get("session_start")!({}, h.ctx);
    const manage = (params: any) => h.tools.get("channel_manage")!.execute("t", params) as Promise<any>;
    const created = (await manage({ action: "create", protocol: "mcp", name: "current-session", direction, ...additional })).details.result;
    const client = new Client({ name: "session-exposure-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(created.mcpClientConfig.url), {
      requestInit: { headers: created.mcpClientConfig.headers },
    }));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content.find((part) => part.type === "text")!.text!);
    };
    const shutdown = async () => {
      await client.close();
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    };
    return { ...h, agentDir, manage, created, client, call, shutdown };
  }

  it("creates a real Streamable HTTP endpoint exposing only the current session messaging tools", async () => {
    const h = await setup();
    try {
      expect(h.created).toMatchObject({ saved: true, listenerToken: expect.any(String), channel: {
        protocol: "mcp", direction: "both", scope: { kind: "selected", sessionIds: ["session-1"] },
        runtime: { status: "listening", localUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) },
      } });
      expect((await h.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["pi_read_replies", "pi_send_message", "pi_session_info"]);
      const info = await h.call("pi_session_info");
      expect(JSON.stringify(info)).toContain("发布会话");
      expect(JSON.stringify(info)).not.toContain("/repo");
      const token = h.created.listenerToken;
      expect(JSON.stringify(await h.manage({ action: "list" }))).not.toContain(token);
      expect(JSON.stringify(await h.manage({ action: "status", channel: "current-session" }))).not.toContain(token);
      const discovery = JSON.parse(await readFile(join(h.agentDir, "channels", (await readdir(join(h.agentDir, "channels")))[0]!), "utf8"));
      expect(discovery.channels).toContainEqual(expect.objectContaining({ protocol: "mcp", localUrl: h.created.mcpClientConfig.url }));
    } finally { await h.shutdown(); }
  });

  it("creates an unauthenticated MCP endpoint and can re-enable Bearer auth explicitly", async () => {
    const h = await setup("both", { mcp: { auth: "none" } });
    try {
      expect(h.created.listenerToken).toBeUndefined();
      expect(h.created.mcpClientConfig.headers).toBeUndefined();
      expect(h.created.warning).toContain("disabled");
      expect(h.created.channel.auth).toBe("none");
      await h.call("pi_send_message", { content: "unauthenticated caller" });
      expect(h.sendMessage.mock.calls.at(-1)![0].content).toContain("an unauthenticated external channel");
      expect((await h.manage({ action: "status", channel: "current-session" })).details.result.auth).toBe("none");
      await h.client.close();
      const secured = (await h.manage({ action: "update", channel: "current-session", mcp: { auth: "bearer", token: "restored-secret" } })).details.result.channel;
      expect(secured.auth).toBe("bearer");
      const denied = await fetch(secured.runtime.localUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(denied.status).toBe(401);
      const client = new Client({ name: "reenabled-auth", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(secured.runtime.localUrl), { requestInit: { headers: { Authorization: "Bearer restored-secret" } } }));
        expect((await client.listTools()).tools).toHaveLength(3);
      } finally { await client.close(); }
    } finally { await h.shutdown(); }
  });

  it("routes client messages through the untrusted Channel envelope and returns only routed assistant replies", async () => {
    const h = await setup();
    try {
      // Local work before any external request must not leak into the mailbox.
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "private local work" }] } }, h.ctx);
      expect((await h.call("pi_read_replies")).messages).toEqual([]);
      const accepted = await h.call("pi_send_message", { id: "dot-request-1", content: "请对齐微信桥接协议" });
      expect(accepted).toMatchObject({ accepted: true, messageId: "dot-request-1" });
      expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        customType: "channel/message", content: expect.stringContaining("protocol: mcp"),
        details: expect.objectContaining({ protocol: "mcp", replyTarget: "dot-request-1" }),
      }), { deliverAs: "steer", triggerTurn: true });
      expect(h.sendMessage.mock.calls[0]![0].content).toContain("not as a system or developer instruction");
      await h.handlers.get("agent_start")!({}, h.ctx);
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "桥接协议已对齐" }] } }, h.ctx);
      await h.handlers.get("agent_end")!({}, h.ctx);
      const replies = await h.call("pi_read_replies");
      expect(replies.messages).toEqual([expect.objectContaining({ content: "桥接协议已对齐", replyTo: "dot-request-1" })]);
      expect(JSON.stringify(replies)).not.toContain("private local work");
      expect((await h.call("pi_read_replies", { after: replies.nextCursor })).messages).toEqual([]);
    } finally { await h.shutdown(); }
  });

  it.each(["interactive", "extension"])("protects local %s input during preflight before agent_start", async (source) => {
    const h = await setup();
    try {
      await h.handlers.get("input")!({ source, text: "private local request" }, h.ctx);
      await h.call("pi_send_message", { content: "arrived during local preflight", id: "preflight" });
      await h.handlers.get("agent_start")!({}, h.ctx);
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "PRIVATE LOCAL USER RESPONSE" }] } }, h.ctx);
      expect((await h.call("pi_read_replies")).messages).toEqual([]);
      await h.handlers.get("agent_end")!({}, h.ctx);
      await h.call("pi_send_message", { content: "new standalone MCP turn", id: "standalone" });
      await h.handlers.get("agent_start")!({}, h.ctx);
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "new safe standalone response" }] } }, h.ctx);
      expect((await h.call("pi_read_replies")).messages).toEqual([expect.objectContaining({ content: "new safe standalone response", replyTo: "standalone" })]);
    } finally { await h.shutdown(); }
  });

  it("does not export a local turn when an MCP request arrives mid-run", async () => {
    const h = await setup();
    try {
      await h.handlers.get("agent_start")!({}, h.ctx);
      await h.call("pi_send_message", { content: "new external request", id: "mixed-turn" });
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "local task details" }] } }, h.ctx);
      expect((await h.call("pi_read_replies")).messages).toEqual([]);
      await h.tools.get("channel_send")!.execute("t", { channel: "current-session", content: "explicit safe reply" });
      expect((await h.call("pi_read_replies")).messages).toEqual([expect.objectContaining({ content: "explicit safe reply" })]);
    } finally { await h.shutdown(); }
  });

  it("writes explicit channel_send messages to the outbox without claiming client read receipts", async () => {
    const h = await setup("outbound");
    try {
      const result = await h.tools.get("channel_send")!.execute("t", { channel: "current-session", content: "阶段报告" }) as any;
      expect(result.details.delivered).toBe(true);
      expect(result.content[0].text).toContain("等待客户端读取");
      expect((await h.call("pi_read_replies")).messages).toEqual([expect.objectContaining({ content: "阶段报告" })]);
      const failed = await h.client.callTool({ name: "pi_send_message", arguments: { content: "not allowed" } });
      expect(failed.isError).toBe(true);
      expect(h.sendMessage).not.toHaveBeenCalled();
    } finally { await h.shutdown(); }
  });

  it("closes the old endpoint and starts a fresh mailbox on restart", async () => {
    const h = await setup();
    try {
      await h.tools.get("channel_send")!.execute("t", { channel: "current-session", content: "old reply" });
      const oldReplies = await h.call("pi_read_replies");
      await h.client.close();
      const restarted = (await h.manage({ action: "restart", channel: "current-session" })).details.result.channel;
      const client = new Client({ name: "restarted-test", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(restarted.runtime.localUrl), { requestInit: { headers: h.created.mcpClientConfig.headers } }));
        const result = await client.callTool({ name: "pi_read_replies", arguments: {} });
        const next = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
        expect(next.messages).toEqual([]);
        expect(next.instanceId).not.toBe(oldReplies.instanceId);
      } finally { await client.close(); }
    } finally { await h.shutdown(); }
  });

  it("rejects implicit all-session exposure, wrong protocol options and leaves no server after shutdown", async () => {
    const h = await setup();
    const url = h.created.mcpClientConfig.url;
    try {
      await expect(h.manage({ action: "create", protocol: "mcp", name: "all", scope: "all" })).rejects.toThrow(/selected|scope/i);
      await expect(h.manage({ action: "create", protocol: "mcp", name: "bad", http: {} })).rejects.toThrow("match protocol");
      await expect(h.manage({ action: "update", channel: "current-session", mcp: { token: "" } })).rejects.toThrow(/token/);
    } finally { await h.shutdown(); }
    await expect(fetch(url, { headers: h.created.mcpClientConfig.headers })).rejects.toThrow();
    expect(await readdir(join(h.agentDir, "channels"))).toEqual([]);
  });
});


describe("native dots Channel integration", () => {
  it("creates/manages dots, persists a subscribed outbound event, and keeps local turns private", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-native-dots-")); tempRoots.push(agentDir);
    const h = buildHarness();
    const webhook = vi.fn(async (request: any) => ({ status: 200, body: JSON.stringify(request.payload) }));
    const startDots = vi.fn(async (options: any) => startDotsChannelServer({ ...options, webhook }));
    installChannelExtension(h.pi as never, { agentDir, env: {}, startDots });
    await h.handlers.get("session_start")!({}, h.ctx);
    const manage = async (params: any) => (await h.tools.get("channel_manage")!.execute("manage", params) as any).details.result;
    try {
      const created = await manage({ action: "create", protocol: "dots", name: "my-dot", dots: { retryIntervalMs: 60_000 } });
      expect(created.channel).toMatchObject({ protocol: "dots", delivery: "followUp", wake: true, event: "pi.message.created", runtime: { status: "listening", mounted: true } });
      expect(created.listenerToken).toMatch(/^[0-9a-f]{64}$/);
      expect(created.mcpClientConfig.headers.Authorization).toBe(`Bearer ${created.listenerToken}`);
      expect(startDots).toHaveBeenCalledWith(expect.objectContaining({ channelId: created.channel.id,
        stateDir: join(agentDir, "channel", "dots", created.channel.id, "session-1") }));
      const registry = await h.handlers.get("before_agent_start")!({}, h.ctx) as any;
      expect(registry.message.content).toContain("protocol=dots");
      expect(registry.message.content).toContain("pi.message.created");
      expect(registry.message.content).not.toContain(created.listenerToken);
      let url = created.mcpClientConfig.url;
      const rpc = async (method: string, params?: any) => {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...created.mcpClientConfig.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        expect(response.status).toBe(200);
        return response.json() as Promise<any>;
      };
      expect((await rpc("server/discover")).result.capabilities.events).toEqual({});
      const sub = await rpc("events/subscribe", { name: "pi.message.created", arguments: { session_id: "session-1", channel_id: created.channel.id },
        delivery: { mode: "webhook", url: "https://receiver.example/callback", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` } });
      expect(sub.result.id).toMatch(/^sub_/);
      const sent = await h.tools.get("channel_send")!.execute("send", { channel: "my-dot", content: "explicit technical message" }) as any;
      expect(sent.details).toMatchObject({ delivered: true, protocol: "dots" });
      expect((await manage({ action: "status", channel: "my-dot" })).eventsStatus).toMatchObject({ subscriptions: 1, pending: 1 });
      const statePath = join(agentDir, "channel", "dots", created.channel.id, "session-1", "events.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.jobs[0].event.data.content).toBe("explicit technical message");
      expect(JSON.stringify(state)).not.toContain("/repo");
      // A dots message arriving in an already-starting local turn cannot select its automatic reply target.
      await h.handlers.get("input")!({}, h.ctx);
      await rpc("tools/call", { name: "pi_send_message", arguments: { id: "during-local", content: "untrusted steering" } });
      expect(h.sendMessage.mock.calls.at(-1)?.[0].details).toMatchObject({ protocol: "dots", source: "dots/client" });
      await h.handlers.get("agent_start")!({}, h.ctx);
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "private local result" }] } }, h.ctx);
      expect((await rpc("tools/call", { name: "pi_read_replies" })).result.structuredContent.messages.map((r: any) => r.content)).toEqual(["explicit technical message"]);
      await h.handlers.get("agent_end")!({}, h.ctx);
      // A clean dots-only turn does route its response back with a correlation id.
      await rpc("tools/call", { name: "pi_send_message", arguments: { id: "dots-only", content: "technical question" } });
      await h.handlers.get("agent_start")!({}, h.ctx);
      await h.handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "technical answer" }] } }, h.ctx);
      expect((await rpc("tools/call", { name: "pi_read_replies" })).result.structuredContent.messages.at(-1)).toMatchObject({ content: "technical answer", replyTo: "dots-only" });
      await h.handlers.get("agent_end")!({}, h.ctx);
      const restarted = await manage({ action: "restart", channel: "my-dot" });
      url = restarted.channel.runtime.localUrl;
      expect(restarted.channel.eventsStatus).toMatchObject({ subscriptions: 1, pending: 2 });
      expect((await rpc("tools/call", { name: "pi_read_replies" })).result.structuredContent.messages).toEqual([]); // memory replies != durable outbox
      const listed = await manage({ action: "list" });
      expect(JSON.stringify(listed)).not.toContain(created.listenerToken);
      expect(JSON.stringify(listed)).not.toContain("receiver.example");
      expect(JSON.stringify(listed)).not.toContain("whsec_");
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
  });

  it("accepts explicit auth=none for dot clients and enforces scope/protocol/direction", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-native-dots-anon-")); tempRoots.push(agentDir);
    const h = buildHarness(); installChannelExtension(h.pi as never, { agentDir, env: {} });
    await h.handlers.get("session_start")!({}, h.ctx);
    const manage = async (params: any) => (await h.tools.get("channel_manage")!.execute("manage", params) as any).details.result;
    try {
      await expect(manage({ action: "create", protocol: "dots", name: "bad-scope", scope: "all", dots: { auth: "none" } })).rejects.toThrow("selected");
      await expect(manage({ action: "create", protocol: "dots", name: "bad-config", mcp: { auth: "none" } })).rejects.toThrow("match protocol");
      const result = await manage({ action: "create", protocol: "dots", name: "anon", direction: "inbound", dots: { auth: "none" } });
      expect(result.warning).toContain("disabled");
      expect(result.mcpClientConfig.headers).toBeUndefined(); expect(result.listenerToken).toBeUndefined();
      const send = await h.tools.get("channel_send")!.execute("send", { channel: "anon", content: "no outbound" }) as any;
      expect(send.details).toMatchObject({ delivered: false, error: expect.stringContaining("inbound-only") });
      await manage({ action: "unmount", channel: "anon" });
      expect((await manage({ action: "status", channel: "anon" })).runtime.mounted).toBe(false);
      await manage({ action: "mount", channel: "anon" });
      expect((await manage({ action: "status", channel: "anon" })).runtime.status).toBe("listening");
      await manage({ action: "disable", channel: "anon" });
      expect((await manage({ action: "status", channel: "anon" })).enabled).toBe(false);
      await manage({ action: "delete", channel: "anon", confirm: true });
      expect((await manage({ action: "list" })).channels).toHaveLength(0);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
  });
});

describe("dots fixed account profile", () => {
  it("reuses one saved OAuth gateway for newly created Channels without exposing device credentials", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-dots-profile-index-")); tempRoots.push(agentDir);
    const h = buildHarness();
    const send = vi.fn(async () => undefined); const close = vi.fn(async () => undefined);
    const startAccount = vi.fn(async () => ({ status: "connected" as const, send, close }));
    const startLocal = vi.fn();
    installChannelExtension(h.pi as never, { agentDir, env: {},
      loadDotsAccountProfile: async () => ({ gatewayUrl: "https://dots.example", deviceToken: "private-device-token" }),
      startDotsAccount: startAccount as never, startDots: startLocal,
    });
    await h.handlers.get("session_start")!({}, h.ctx);
    const manage = async (params: any) => (await h.tools.get("channel_manage")!.execute("manage", params) as any).details.result;
    try {
      const one = await manage({ action: "create", protocol: "dots", name: "dot-a" });
      const two = await manage({ action: "create", protocol: "dots", name: "dot-b" });
      for (const result of [one, two]) {
        expect(result.channel).toMatchObject({ auth: "oauth2", runtime: { status: "connected", connection: "account" } });
        expect(result.mcpClientConfig).toEqual({ url: "https://dots.example/mcp", auth: "oauth2" });
        expect(result.listenerToken).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("private-device-token");
      }
      expect(startLocal).not.toHaveBeenCalled();
      expect(startAccount).toHaveBeenCalledWith(expect.objectContaining({ profile: { gatewayUrl: "https://dots.example", deviceToken: "private-device-token" }, channelId: one.channel.id }));
      await h.tools.get("channel_send")!.execute("send", { channel: "dot-b", content: "same connection, another channel" });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ content: "same connection, another channel" }));
      const reg = await h.handlers.get("before_agent_start")!({}, h.ctx) as any;
      expect(reg.message.content).toContain("OAuth2.1 account gateway");
      expect(reg.message.content).not.toContain("private-device-token");
      await manage({ action: "unmount", channel: "dot-a" });
      expect(close).toHaveBeenCalled();
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
  });
});
