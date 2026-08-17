import { createCipheriv } from "node:crypto";
import {
  buildWechatCdnDownloadUrl,
  downloadWechatImage,
} from "./wechatMedia.js";

function encrypt(data: Buffer, keyHex: string): Buffer {
  const remainder = data.byteLength % 16;
  const padLength = remainder === 0 ? 16 : 16 - remainder;
  const padded = Buffer.concat([data, Buffer.alloc(padLength, padLength)]);
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(keyHex, "hex"), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

describe("WeChat image media", () => {
  it("accepts the base64-wrapped ASCII hex key used by iLink media", async () => {
    const keyHex = "00112233445566778899aabbccddeeff";
    const key = Buffer.from(keyHex, "utf8").toString("base64");
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]);
    const encrypted = encrypt(jpeg, keyHex);
    const fetcher = vi.fn(async () => new Response(Uint8Array.from(encrypted), {
      status: 200,
      headers: { "Content-Length": String(encrypted.byteLength) },
    }));

    await expect(downloadWechatImage(
      { url: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1", aesKey: key },
      { fetcher: fetcher as typeof fetch },
    )).resolves.toEqual({ data: jpeg.toString("base64"), mimeType: "image/jpeg" });
  });

  it("rejects untrusted download hosts before fetching", async () => {
    const fetcher = vi.fn();
    await expect(downloadWechatImage(
      { url: "https://example.com/image.png" },
      { fetcher: fetcher as typeof fetch },
    )).rejects.toThrow("受信任的 CDN");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects bodies over the configured cap", async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(32), {
      status: 200,
      headers: { "Content-Length": "32" },
    }));
    await expect(downloadWechatImage(
      { url: "https://novac2c.cdn.weixin.qq.com/c2c/download?x=1" },
      { fetcher: fetcher as typeof fetch, maxBytes: 16 },
    )).rejects.toThrow("超过 16 字节限制");
  });

  it("builds the trusted CDN URL from encrypted_query_param", () => {
    expect(buildWechatCdnDownloadUrl("a+b/c=")).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D",
    );
  });
});
