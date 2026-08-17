import { createDecipheriv } from "node:crypto";

const WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const TRUSTED_IMAGE_HOST_SUFFIXES = [
  "weixin.qq.com",
  "wechat.com",
  "qpic.cn",
] as const;

export const DEFAULT_WECHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_WECHAT_IMAGES_PER_MESSAGE = 5;

export interface WechatImageReference {
  url: string;
  aesKey?: string;
}

export interface WechatImageData {
  data: string;
  mimeType: string;
}

export function buildWechatCdnDownloadUrl(encryptedQueryParam: string): string {
  return `${WECHAT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function isTrustedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return TRUSTED_IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function decodeAesKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-f]{32}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");

  const decoded = Buffer.from(trimmed, "base64");
  const asciiHex = decoded.toString("utf8").trim();
  if (/^[0-9a-f]{32}$/i.test(asciiHex)) return Buffer.from(asciiHex, "hex");
  if (decoded.byteLength === 16) return decoded;
  throw new Error("微信图片 AES key 格式无效");
}

function decryptImage(encrypted: Buffer, aesKey: string): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", decodeAesKey(aesKey), null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const padLength = decrypted.at(-1) ?? 0;
  if (padLength < 1 || padLength > 16 || decrypted.byteLength < padLength) return decrypted;
  const padding = decrypted.subarray(decrypted.byteLength - padLength);
  return padding.every((byte) => byte === padLength)
    ? decrypted.subarray(0, decrypted.byteLength - padLength)
    : decrypted;
}

function detectImageMimeType(data: Buffer): string | undefined {
  if (data.byteLength >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.byteLength >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (data.byteLength >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`微信图片超过 ${maxBytes} 字节限制`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > maxBytes) throw new Error(`微信图片超过 ${maxBytes} 字节限制`);
    return data;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`微信图片超过 ${maxBytes} 字节限制`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadWechatImage(
  reference: WechatImageReference,
  options: {
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    maxBytes?: number;
  } = {},
): Promise<WechatImageData> {
  if (!isTrustedImageUrl(reference.url)) {
    throw new Error("微信图片下载地址不在受信任的 CDN 域名内");
  }

  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetcher ?? fetch)(reference.url, {
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`微信图片下载失败: HTTP ${response.status}`);

  const encrypted = await readBodyCapped(response, options.maxBytes ?? DEFAULT_WECHAT_IMAGE_MAX_BYTES);
  const image = reference.aesKey ? decryptImage(encrypted, reference.aesKey) : encrypted;
  const mimeType = detectImageMimeType(image);
  if (!mimeType) throw new Error("微信图片格式不受支持或解密失败");
  return { data: image.toString("base64"), mimeType };
}
