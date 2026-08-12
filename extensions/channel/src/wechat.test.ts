import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelDefinition } from "./store.js";
import {
  loginWechatChannel,
  startWechatTransport,
  wechatCredentialsPath,
  type WechatInboundMessage,
} from "./wechat.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WeChat ClawBot channel", () => {
  it("logs in by QR, long-polls text, remembers the reply target, and sends text", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-wechat-"));
    roots.push(root);
    const channel = createChannelDefinition({
      name: "我的微信",
      protocol: "wechat",
      direction: "both",
      scope: "selected",
      sessionId: "session-a",
    });
    const sentBodies: unknown[] = [];
    let updates = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/get_bot_qrcode")) {
        return json({ qrcode: "qr-token", qrcode_img_content: "https://weixin.qq.com/qr/test" });
      }
      if (url.pathname.endsWith("/get_qrcode_status")) {
        return json({
          status: "confirmed",
          bot_token: "bot-token",
          ilink_bot_id: "bot-id",
          ilink_user_id: "login-user",
          baseurl: "https://ilinkai.weixin.qq.com",
        });
      }
      if (url.pathname.endsWith("/getupdates")) {
        updates += 1;
        if (updates === 1) {
          return json({
            ret: 0,
            get_updates_buf: "cursor-1",
            msgs: [{
              message_id: "wx-1",
              from_user_id: "wx-user-1",
              message_type: 1,
              create_time_ms: Date.parse("2026-08-03T01:02:03.000Z"),
              context_token: "context-1",
              item_list: [{ type: 1, text_item: { text: "请把阶段产物发到产物群" } }],
            }],
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (url.pathname.endsWith("/sendmessage")) {
        sentBodies.push(JSON.parse(String(init?.body)));
        return json({ ret: 0 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const qr = vi.fn();
    await loginWechatChannel(root, channel, {
      fetcher: fetcher as typeof fetch,
      pollIntervalMs: 1,
      onQr: qr,
    });
    expect(qr).toHaveBeenCalledWith(expect.stringContaining("█"), "https://weixin.qq.com/qr/test");
    expect((await stat(wechatCredentialsPath(root, channel.id))).mode & 0o777).toBe(0o600);

    let resolveMessage!: (message: WechatInboundMessage) => void;
    const received = new Promise<WechatInboundMessage>((resolve) => { resolveMessage = resolve; });
    const transport = await startWechatTransport({
      agentDir: root,
      channel,
      fetcher: fetcher as typeof fetch,
      onMessage: (message) => resolveMessage(message),
    });
    const message = await received;
    expect(message).toMatchObject({
      id: "wx-1",
      userId: "wx-user-1",
      content: "请把阶段产物发到产物群",
    });

    await transport.send("已经发送");
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toMatchObject({
      msg: {
        to_user_id: "wx-user-1",
        context_token: "context-1",
        item_list: [{ text_item: { text: "已经发送" } }],
      },
    });

    await vi.waitFor(async () => {
      const state = JSON.parse(await readFile(join(root, "channel", "wechat", channel.id, "state.json"), "utf8"));
      expect(state).toMatchObject({ lastUserId: "wx-user-1", contextTokens: { "wx-user-1": "context-1" } });
    });
    const sharedTransport = await startWechatTransport({
      agentDir: root,
      channel,
      fetcher: fetcher as typeof fetch,
      onMessage: vi.fn(),
    });
    expect(sharedTransport).toMatchObject({
      status: "occupied",
      detail: expect.stringContaining("本会话可共享发送"),
    });
    await sharedTransport.send("跨会话发送");
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[1]).toMatchObject({
      msg: {
        to_user_id: "wx-user-1",
        context_token: "context-1",
        item_list: [{ text_item: { text: "跨会话发送" } }],
      },
    });
    await sharedTransport.close();
    await transport.close();
  });
});
