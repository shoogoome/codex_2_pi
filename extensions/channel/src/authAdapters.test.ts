import {
  buildAuthTargetOptions,
  createMultiSessionChannel,
  uniqueDefaultChannelName,
  type ChannelAuthAdapter,
} from "./authAdapters.js";
import type { ChannelDefinition, ChannelSessionIdentity } from "./types.js";

const session: ChannelSessionIdentity = { id: "session-a", name: "A", cwd: "/repo" };

function adapter(protocol: "http" | "wechat", label: string): ChannelAuthAdapter {
  return {
    protocol,
    protocolLabel: label,
    actionLabel: protocol === "wechat" ? "扫码登录" : "OAuth 登录",
    defaultChannelName: label,
    createChannel: (target, name) => createMultiSessionChannel({
      protocol,
      name,
      session: target,
      protocolConfig: protocol === "wechat"
        ? { wechat: {} }
        : {
            http: {
              host: "127.0.0.1",
              port: 0,
              token: "token",
              callbackUrl: "https://example.com/callback",
              maxBodyBytes: 65536,
              rateLimitPerMinute: 30,
              idempotencyTtlMs: 600000,
            },
          },
    }),
    authenticate: async () => undefined,
  };
}

describe("Channel authentication adapters", () => {
  it("builds protocol-neutral existing-channel and create-provider targets", () => {
    const wechat = adapter("wechat", "微信 ClawBot");
    const oauth = adapter("http", "企业 OAuth");
    const channels: ChannelDefinition[] = [
      wechat.createChannel(session, "个人微信"),
      oauth.createChannel(session, "企业通知"),
    ];

    expect(buildAuthTargetOptions(channels, [wechat, oauth])).toEqual([
      expect.objectContaining({ kind: "channel", protocol: "wechat", label: "扫码登录「个人微信」 · 微信 ClawBot" }),
      expect.objectContaining({ kind: "channel", protocol: "http", label: "OAuth 登录「企业通知」 · 企业 OAuth" }),
      expect.objectContaining({ kind: "create", protocol: "wechat", label: "新建 微信 ClawBot Channel 并扫码登录" }),
      expect.objectContaining({ kind: "create", protocol: "http", label: "新建 企业 OAuth Channel 并OAuth 登录" }),
    ]);
  });

  it("creates authenticated channels as multi-session with a local direction override", () => {
    const channel = adapter("wechat", "微信").createChannel(session, "微信");
    expect(channel).toMatchObject({
      direction: "both",
      sessionDirections: { "session-a": "both" },
      scope: { kind: "selected", sessionIds: ["session-a"] },
    });
  });

  it("allocates non-conflicting provider default names", () => {
    const wechat = adapter("wechat", "微信");
    const channels = [
      wechat.createChannel(session, "微信"),
      wechat.createChannel(session, "微信 2"),
    ];
    expect(uniqueDefaultChannelName("微信", channels)).toBe("微信 3");
  });
});
