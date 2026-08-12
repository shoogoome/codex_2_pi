import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installChannelExtension } from "./index.js";
import { createChannelDefinition, saveChannelSettings } from "./src/store.js";

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
