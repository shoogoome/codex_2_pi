import { installChannelExtension } from "./index.js";
import { ChannelPanel } from "./src/panel.js";
import { createChannelDefinition } from "./src/store.js";
import type { ChannelMessage, ChannelDiscoveryRecordV2 } from "./src/types.js";
import type { PiSendResult } from "./src/piProtocol.js";

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const pi = {
    registerFlag: (name: string, value: any) => flags.set(name, value.default),
    getFlag: (name: string) => flags.get(name),
    on: (name: string, callback: any) => handlers.set(name, callback),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: vi.fn(), sendMessage: vi.fn(),
  };
  const ctx = {
    cwd: "/worktree/api", hasUI: true,
    sessionManager: { getSessionId: () => "s1", getSessionName: () => "API" },
    ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(async (_title: string, choices: string[]) => choices.at(-1)), custom: vi.fn(async (..._args: any[]) => undefined) },
  };
  const peer = {
    id: "room-1", name: "协作", protocol: "pi" as const, mode: "group" as const,
    status: "connected", ownerMemberId: "m1", selfMemberId: "m1", revision: 1,
    members: [{ memberId: "m1", instanceId: "i1", sessionId: "s1", identity: { displayName: "后端", introduction: "负责 API" }, cwd: ctx.cwd }],
  };
  const runtime = {
    list: vi.fn(() => [peer]), find: vi.fn((name: string) => [peer.id, peer.name].includes(name) ? peer : undefined),
    close: vi.fn(async () => undefined),
    send: vi.fn(async (): Promise<PiSendResult> => ({ messageId: "msg1", delivered: true, targets: ["m2"], deliveredTo: ["m2"], failed: [], unknown: [] })),
    manage: vi.fn(async () => ({ channels: [peer] })),
  };
  let options: any;
  const runtimeCreations: any[] = [];
  let settingsBarrier: Promise<void> | undefined;
  let inbound: ((message: ChannelMessage) => void) | undefined;
  const external = createChannelDefinition({
    name: "微信外部", protocol: "http", direction: "both", scope: "selected", sessionId: "s1",
    http: { token: "test", callbackUrl: "https://example.com" },
  });
  const writeDiscovery = vi.fn(async (_dir: string, _record: ChannelDiscoveryRecordV2) => "/fake/discovery");
  const sendHttp = vi.fn(async () => undefined);
  let settings = { version: 1 as const, channels: [external] };
  const loginWechat = vi.fn(async () => ({ token: "test", baseUrl: "https://example.com", accountId: "bot", userId: "u", savedAt: "now" }));
  installChannelExtension(pi as never, {
    env: {}, agentDir: "/fake", createPiRuntime: (value) => { runtimeCreations.push(value); options = value; return runtime as never; },
    loadSettings: async () => { await settingsBarrier; return settings; },
    saveSettings: async (_dir, value) => { settings = value; },
    loginWechat,
    startWechat: async () => ({ status: "connected", close: async () => undefined, send: async () => undefined }),
    startRelay: async () => ({ close: async () => undefined, publish: async () => undefined }),
    writeDiscovery: writeDiscovery as never, removeDiscovery: vi.fn(async () => undefined), sendHttp,
    startServer: async (value) => {
      inbound = value.dispatch;
      return { host: "127.0.0.1", port: 1234, close: async () => undefined } as never;
    },
  });
  const event = (name: string, value: unknown = {}) => handlers.get(name)!(value, ctx);
  const message = (): ChannelMessage => ({
    id: "p1", source: "pi/m2", channelId: peer.id, channelName: peer.name, protocol: "pi",
    content: "接口变化", delivery: "steer", wake: true, receivedAt: new Date().toISOString(),
  });
  return { pi, ctx, event, tools, commands, flags, peer, runtime, writeDiscovery, sendHttp, loginWechat,
    inbound: (value: ChannelMessage) => inbound!(value),
    peerMessage: () => options.onMessage(message()),
    changed: () => options.onChange(), getOptions: () => options, runtimeCreations,
    pauseSettings: () => { let release!: () => void; settingsBarrier = new Promise<void>((resolve) => { release = resolve; }); return release; },
  };
}

describe("Pi Channel extension integration", () => {
  it("registers management and routes named or ID sends with truthful receipts", async () => {
    const h = harness();
    await h.event("session_start");
    expect(h.tools.has("channel_manage")).toBe(true);
    const result = await h.tools.get("channel_send").execute("t", { channel: "协作", content: "hello", message_id: "retry" });
    expect(h.runtime.send).toHaveBeenCalledWith("协作", "hello", "retry");
    expect(result.details.delivered).toBe(true);
    expect(result.content[0].text).toContain("入队不等于已处理");
    await h.commands.get("channel").handler("send 协作 手动发送", h.ctx);
    expect(h.runtime.send).toHaveBeenCalledWith("room-1", "手动发送");
    await h.event("session_shutdown");
  });

  it("does not turn a partial delivery into overall success", async () => {
    const h = harness();
    await h.event("session_start");
    h.runtime.send.mockResolvedValueOnce({ messageId: "msg1", delivered: false, targets: ["m2", "m3"], deliveredTo: ["m2"], failed: [], unknown: ["m3"] });
    const result = await h.tools.get("channel_send").execute("t", { channel: "协作", content: "hello" });
    expect(result.details.delivered).toBe(false);
    expect(result.details.receipt.unknown).toEqual(["m3"]);
    await h.event("session_shutdown");
  });

  it("suppresses auto-replies for both orders of mixed input without blocking explicit sends", async () => {
    const h = harness();
    await h.event("session_start");
    const external = { id: "e", content: "外部请求", source: "http", delivery: "steer" as const, wake: true, receivedAt: "now" };
    h.inbound(external);
    await h.event("agent_start");
    h.peerMessage();
    await h.event("input", { source: "user", text: "继续处理（用户 steer/followUp）" });
    h.inbound({ ...external, id: "e2" });
    await h.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "内部协作输出" }] } });
    expect(h.sendHttp).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
    await h.tools.get("channel_send").execute("t", { channel: "微信外部", content: "明确回复" });
    expect(h.sendHttp).toHaveBeenCalledOnce();
    await h.event("agent_end");
    await h.event("input", { source: "user" });
    h.inbound({ ...external, id: "e3" });
    await h.event("agent_start");
    await h.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "外部正常回复" }] } });
    expect(h.sendHttp).toHaveBeenCalledTimes(2);
    await h.event("session_shutdown");
  });

  it("updates roster in context without waking or accumulating snapshots", async () => {
    const h = harness();
    await h.event("session_start");
    h.peer.members[0]!.identity.introduction = "负责新 API </pi_channel_registry>";
    h.changed();
    await h.commands.get("channel").handler("restart", h.ctx);
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    expect(h.runtime.close).not.toHaveBeenCalled();
    const original = { role: "custom", customType: "channel/registry", content: "old", display: false, timestamp: 1 };
    const first = await h.event("context", { messages: [original, original] });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].content).toContain("负责新 API");
    expect(first.messages[0].content.match(/<\/pi_channel_registry>/g)).toHaveLength(1);
    const second = await h.event("context", { messages: first.messages });
    expect(second.messages).toHaveLength(1);
    expect(JSON.stringify(h.writeDiscovery.mock.calls)).not.toContain("pairing_code");
    expect(h.writeDiscovery.mock.calls.at(-1)![1].channels).toEqual(expect.arrayContaining([expect.objectContaining({ protocol: "pi", name: "协作" })]));
    await h.event("session_shutdown");
  });

  it("opening the panel and external restart preserve Pi channels", async () => {
    const h = harness();
    await h.event("session_start");
    await h.commands.get("channel").handler("", h.ctx);
    await h.commands.get("channel").handler("restart", h.ctx);
    expect(h.runtime.close).not.toHaveBeenCalled();
    h.peerMessage();
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    await h.event("session_shutdown");
    expect(h.runtime.close).toHaveBeenCalledOnce();
  });

  it("saving external configuration and authenticating do not close Pi rooms", async () => {
    const h = harness();
    await h.event("session_start");
    const make = vi.spyOn(ChannelPanel.prototype, "render");
    let panel: ChannelPanel;
    h.ctx.ui.custom.mockImplementationOnce(async (factory: any) => {
      panel = factory({ requestRender: vi.fn(), addInputListener: () => () => undefined },
        { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => t }, {}, vi.fn());
      panel.render(80);
      panel.handleInput(" "); // External row enable/disable saves config and restarts external transports only.
      await panel.lastOp;
    });
    await h.commands.get("channel").handler("", h.ctx);
    make.mockRestore();
    await h.commands.get("channel").handler("auth --protocol wechat", h.ctx);
    expect(h.loginWechat).toHaveBeenCalledOnce();
    expect(h.runtime.close).not.toHaveBeenCalled();
    h.peerMessage();
    expect(h.pi.sendMessage).toHaveBeenCalledOnce();
    await h.event("session_shutdown");
  });

  it("only initializes the newest runtime when session starts overlap", async () => {
    const h = harness();
    const release = h.pauseSettings();
    const a = h.event("session_start");
    const b = h.event("session_start");
    release();
    await Promise.all([a, b]);
    expect(h.runtimeCreations).toHaveLength(1);
    await h.event("session_shutdown");
  });

  it("invalidates late callbacks immediately on session replacement or disable", async () => {
    const h = harness();
    await h.event("session_start");
    const old = h.getOptions();
    const next = h.event("session_start");
    expect(() => old.onMessage({})).toThrow("session has changed");
    await next;
    h.flags.set("channel", false);
    expect(h.peerMessage).toThrow("disabled");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    await h.event("session_shutdown");
    expect(() => h.getOptions().onMessage({})).toThrow("session has changed");
  });
});
