import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

function encryptWechatImage(data: Buffer, keyHex: string): Buffer {
  const padLength = 16 - (data.byteLength % 16 || 16) || 16;
  const padded = Buffer.concat([data, Buffer.alloc(padLength, padLength)]);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
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
    const uploadRequests: any[] = [];
    const uploaded: Buffer[] = [];
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
      if (url.pathname.endsWith("/getuploadurl")) {
        uploadRequests.push(JSON.parse(String(init?.body)));
        return json({ ret: 0, upload_param: "upload+a/b=" });
      }
      if (url.pathname.endsWith("/upload")) {
        expect(url.hostname).toBe("novac2c.cdn.weixin.qq.com");
        expect(url.searchParams.get("encrypted_query_param")).toBe("upload+a/b=");
        expect(init?.headers).toEqual({ "Content-Type": "application/octet-stream" });
        expect(init?.redirect).toBe("error");
        uploaded.push(Buffer.from(init?.body as Uint8Array));
        return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-param" } });
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
    const imagePath = join(root, "test.png");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(imagePath, png);
    try {
      await transport.sendImage!(imagePath, "wx-user-1", "这是截图");
      await sharedTransport.sendImage!(imagePath);
      expect(uploadRequests).toHaveLength(2);
      for (const [i, upload] of uploadRequests.entries()) {
        expect(upload).toMatchObject({
          media_type: 1, to_user_id: "wx-user-1", rawsize: png.length,
          rawfilemd5: createHash("md5").update(png).digest("hex"),
          filesize: uploaded[i].length, no_need_thumb: true,
        });
        expect(upload.filekey).toMatch(/^[0-9a-f]{32}$/);
        const decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
        expect(Buffer.concat([decipher.update(uploaded[i]), decipher.final()])).toEqual(png);
        const body = sentBodies[i + 2] as any;
        expect(body.msg).toMatchObject({ to_user_id: "wx-user-1", context_token: "context-1", message_type: 2, message_state: 2 });
        expect(body.msg.item_list.at(-1)).toEqual({
          type: 2, image_item: {
            media: { encrypt_query_param: "download-param", aes_key: Buffer.from(upload.aeskey, "utf8").toString("base64"), encrypt_type: 1 },
            mid_size: uploaded[i].length,
          },
        });
      }
      expect((sentBodies[2] as any).msg.item_list[0]).toEqual({ type: 1, text_item: { text: "这是截图" } });
      expect((sentBodies[3] as any).msg.item_list).toHaveLength(1);
    } finally {
      await sharedTransport.close();
      await transport.close();
    }
  });

  it("downloads, decrypts, and forwards a pure image message", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-channel-wechat-image-"));
    roots.push(root);
    const channel = createChannelDefinition({
      name: "图片微信",
      protocol: "wechat",
      direction: "both",
      scope: "selected",
      sessionId: "session-image",
    });
    const keyHex = "00112233445566778899aabbccddeeff";
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("test-png-payload"),
    ]);
    const encrypted = encryptWechatImage(png, keyHex);
    let updates = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/get_bot_qrcode")) {
        return json({ qrcode: "qr-token", qrcode_img_content: "https://weixin.qq.com/qr/image" });
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
            get_updates_buf: "cursor-image",
            msgs: [{
              message_id: "wx-image-1",
              from_user_id: "wx-user-image",
              message_type: 1,
              context_token: "context-image",
              item_list: [{
                type: 2,
                image_item: {
                  aeskey: keyHex,
                  media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?image=1" },
                },
              }],
            }],
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      if (url.hostname === "novac2c.cdn.weixin.qq.com") {
        return new Response(Uint8Array.from(encrypted), {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(encrypted.byteLength),
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await loginWechatChannel(root, channel, {
      fetcher: fetcher as typeof fetch,
      pollIntervalMs: 1,
    });
    let resolveMessage!: (message: WechatInboundMessage) => void;
    const received = new Promise<WechatInboundMessage>((resolve) => { resolveMessage = resolve; });
    const errors = vi.fn();
    const transport = await startWechatTransport({
      agentDir: root,
      channel,
      fetcher: fetcher as typeof fetch,
      onMessage: resolveMessage,
      onError: errors,
    });

    await expect(received).resolves.toMatchObject({
      id: "wx-image-1",
      userId: "wx-user-image",
      content: "用户通过微信发送了一张图片，请分析图片内容。",
      images: [{ data: png.toString("base64"), mimeType: "image/png" }],
    });
    expect(errors).not.toHaveBeenCalled();
    await transport.close();
  });
});
