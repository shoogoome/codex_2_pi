import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelDefinition } from "./store.js";
import { startWechatTransport } from "./wechat.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(response: Record<string, unknown> = { upload_param: "upload" }, cdnStatus = 200, downloadParam: string | null = "download") {
  const root = await mkdtemp(join(tmpdir(), "wx-outbound-"));
  roots.push(root);
  const channel = createChannelDefinition({ name: "wx", protocol: "wechat", direction: "outbound", scope: "all", sessionId: "a" });
  const dir = join(root, "channel", "wechat", channel.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "credentials.json"), JSON.stringify({ token: "secret", baseUrl: "https://ilinkai.weixin.qq.com" }));
  await writeFile(join(dir, "state.json"), JSON.stringify({ cursor: "", lastUserId: "user", contextTokens: { user: "context" } }));
  await writeFile(join(dir, "session.lock"), JSON.stringify({ pid: process.pid, instanceId: "other" }));
  const image = join(root, "test.png");
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("getuploadurl")) return Response.json({ ret: 0, ...response });
    if (url.pathname.endsWith("upload")) return new Response(null, { status: cdnStatus, headers: downloadParam ? { "x-encrypted-param": downloadParam } : {} });
    if (url.pathname.endsWith("sendmessage")) {
      const body = JSON.parse(String(init?.body));
      if (body.msg.item_list.length !== 1) return Response.json({ ret: -1, errmsg: "invalid arguments" });
      return Response.json({ ret: 0 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const transport = await startWechatTransport({ agentDir: root, channel, fetcher: fetcher as typeof fetch, onMessage: vi.fn() });
  return { root, dir, image, fetcher, transport };
}

describe("WeChat outbound image failures", () => {
  it("sends image then caption as two single-item messages to the same target", async () => {
    const { transport, image, fetcher } = await setup();
    await transport.sendImage!(image, undefined, "说明");
    const messages = fetcher.mock.calls
      .filter(([url]) => String(url).endsWith("sendmessage"))
      .map(([, init]) => JSON.parse(String(init?.body)).msg);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.item_list.map((item: any) => item.type))).toEqual([[2], [1]]);
    expect(messages[1].item_list[0].text_item.text).toBe("说明");
    expect(messages.every((message) => message.to_user_id === "user" && message.context_token === "context")).toBe(true);
  });

  it("reports image delivery when only the caption fails, without resending", async () => {
    const { transport, image, fetcher } = await setup();
    fetcher.mockImplementationOnce(async () => Response.json({ upload_param: "upload" }));
    fetcher.mockImplementationOnce(async () => new Response(null, { headers: { "x-encrypted-param": "download" } }));
    fetcher.mockImplementationOnce(async () => Response.json({ ret: 0 }));
    fetcher.mockImplementationOnce(async () => Response.json({ ret: -14, errmsg: "expired context" }));
    await expect(transport.sendImage!(image, undefined, "说明")).rejects.toMatchObject({
      imageDelivered: true,
      message: expect.stringContaining("图片已发送，但说明文字发送失败"),
    });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("sendmessage"))).toHaveLength(2);
  });
  it("uses upload_full_url as a fallback without following an arbitrary host", async () => {
    const { transport, image, fetcher } = await setup({ upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=full%2Bparam" });
    await transport.sendImage!(image);
    expect(String(fetcher.mock.calls[1][0])).toContain("encrypted_query_param=full%2Bparam");
  });

  it.each([
    [{}, 200, "download", "upload_param"],
    [{ upload_full_url: "https://evil.example/upload?encrypted_query_param=x" }, 200, "download", "受信任"],
    [{ ret: -1, errmsg: "prepare failed" }, 200, "download", "/ilink/bot/getuploadurl: prepare failed (code -1)"],
    [{ upload_param: "upload" }, 503, "download", "HTTP 503"],
    [{ upload_param: "upload" }, 200, null, "x-encrypted-param"],
  ] as const)("does not send a message after upload failure %#", async (response, status, downloadParam, error) => {
    const { transport, image, fetcher } = await setup(response, status, downloadParam);
    await expect(transport.sendImage!(image)).rejects.toThrow(error);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("sendmessage"))).toBe(false);
  });

  it("requires the target's context token before any upload", async () => {
    const { transport, image, fetcher, dir } = await setup();
    await writeFile(join(dir, "state.json"), JSON.stringify({ cursor: "", lastUserId: "user", contextTokens: {} }));
    await expect(transport.sendImage!(image)).rejects.toThrow("context token");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("honors cancellation and caption limits before uploading", async () => {
    const { transport, image, fetcher } = await setup();
    const abort = new AbortController();
    abort.abort();
    await expect(transport.sendImage!(image, undefined, undefined, abort.signal)).rejects.toThrow();
    await expect(transport.sendImage!(image, undefined, "a".repeat(1201))).rejects.toThrow("1200");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates sendmessage errors instead of reporting success", async () => {
    const { transport, image, fetcher } = await setup();
    fetcher.mockImplementationOnce(async () => Response.json({ upload_param: "upload" }));
    fetcher.mockImplementationOnce(async () => new Response(null, { headers: { "x-encrypted-param": "download" } }));
    fetcher.mockImplementationOnce(async () => Response.json({ ret: -14, errmsg: "expired context" }));
    await expect(transport.sendImage!(image)).rejects.toThrow("/ilink/bot/sendmessage: expired context (code -14)");
  });
});
