import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import qrcode from "qrcode-terminal";
import type { ChannelDefinition, ChannelImage } from "./types.js";
import {
  buildWechatCdnDownloadUrl,
  DEFAULT_WECHAT_IMAGE_MAX_BYTES,
  downloadWechatImage,
  isTrustedImageUrl,
  prepareWechatImage,
  MAX_WECHAT_IMAGES_PER_MESSAGE,
  type WechatImageReference,
} from "./wechatMedia.js";

/**
 * iLink/ClawBot text and bidirectional image transport. The wire/media format follows
 * the MIT-licensed shenjiecode/pi-wechat-assistant project, while lifecycle,
 * scoping and routing are owned by this Channel extension.
 */

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.0";
const UIN = Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");

export interface WechatCredentials {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

interface WechatPersistedState {
  cursor: string;
  lastUserId?: string;
  contextTokens: Record<string, string>;
}

interface RawWechatMessage {
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  create_time_ms?: number;
  context_token?: string;
  item_list?: Array<{
    type?: number;
    text_item?: { text?: string };
    image_item?: {
      aeskey?: string;
      url?: string;
      media?: {
        full_url?: string;
        encrypt_query_param?: string;
        aes_key?: string;
      };
    };
    voice_item?: { text?: string };
    ref_msg?: { message_item?: { text_item?: { text?: string } } };
  }>;
}

interface UpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: RawWechatMessage[];
  get_updates_buf?: string;
}

interface QrResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface QrStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

export interface WechatInboundMessage {
  id: string;
  userId: string;
  content: string;
  images?: ChannelImage[];
  receivedAt: string;
}

export interface RunningWechatTransport {
  status: "connected" | "occupied";
  detail?: string;
  send(content: string, replyTarget?: string): Promise<void>;
  sendImage?(path: string, replyTarget?: string, content?: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export class WechatImageCaptionError extends Error {
  readonly imageDelivered = true;

  constructor(cause: unknown) {
    super(`图片已发送，但说明文字发送失败；请勿重发图片，仅重试文字：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WechatImageCaptionError";
  }
}

export class WechatNotLoggedInError extends Error {
  constructor(channelName: string) {
    super(`微信 Channel "${channelName}" 尚未登录，请在 /channel 面板选择登录/认证，或执行 /channel auth ${channelName}`);
    this.name = "WechatNotLoggedInError";
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

function stateDir(agentDir: string, channelId: string): string {
  return join(agentDir, "channel", "wechat", channelId);
}

export function wechatCredentialsPath(agentDir: string, channelId: string): string {
  return join(stateDir(agentDir, channelId), "credentials.json");
}

function wechatStatePath(agentDir: string, channelId: string): string {
  return join(stateDir(agentDir, channelId), "state.json");
}

function wechatLockPath(agentDir: string, channelId: string): string {
  return join(stateDir(agentDir, channelId), "session.lock");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function headers(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(token
      ? {
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${token}`,
          "X-WECHAT-UIN": UIN,
        }
      : {}),
  };
}

async function parseResponse<T>(response: Response, label: string): Promise<T> {
  const raw = await response.text();
  let body: T & { ret?: number; errcode?: number; errmsg?: string };
  try {
    body = (raw ? JSON.parse(raw) : {}) as typeof body;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!response.ok || (typeof body.ret === "number" && body.ret !== 0)) {
    const code = body.errcode ?? body.ret;
    // Preserve the API stage without exposing tokens or signed media URLs.
    const reason = body.errmsg || `HTTP ${response.status}`;
    const error = new Error(`${label}: ${reason}${typeof code === "number" ? ` (code ${code})` : ""}`) as Error & { code?: number };
    error.code = code;
    throw error;
  }
  return body;
}

async function apiGet<T>(baseUrl: string, path: string, extraHeaders: Record<string, string> = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(new URL(path, `${normalizeBaseUrl(baseUrl)}/`), {
    headers: extraHeaders,
    signal: AbortSignal.timeout(15_000),
  });
  return parseResponse<T>(response, path);
}

async function apiPost<T>(
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number; fetcher?: typeof fetch } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 40_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetcher ?? fetch)(new URL(path, `${normalizeBaseUrl(baseUrl)}/`), {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
    signal,
  });
  return parseResponse<T>(response, path);
}

function baseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION };
}

async function getQr(baseUrl: string, fetcher?: typeof fetch): Promise<QrResponse> {
  return apiGet<QrResponse>(baseUrl, "/ilink/bot/get_bot_qrcode?bot_type=3", {}, fetcher);
}

async function getQrStatus(baseUrl: string, token: string, fetcher?: typeof fetch): Promise<QrStatusResponse> {
  return apiGet<QrStatusResponse>(
    baseUrl,
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(token)}`,
    { "iLink-App-ClientVersion": "1" },
    fetcher,
  );
}

function renderQr(value: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(value, { small: true }, resolve));
}

export async function loginWechatChannel(
  agentDir: string,
  channel: ChannelDefinition,
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    pollIntervalMs?: number;
    onQr?(ascii: string, url: string): void;
    onStatus?(status: string): void;
  } = {},
): Promise<WechatCredentials> {
  if (channel.protocol !== "wechat") throw new Error(`Channel "${channel.name}" is not WeChat`);
  let baseUrl = normalizeBaseUrl(channel.wechat?.baseUrl);
  let qr = await getQr(baseUrl, options.fetcher);
  options.onQr?.(await renderQr(qr.qrcode_img_content), qr.qrcode_img_content);
  let refreshes = 0;
  let lastStatus = "";
  while (!options.signal?.aborted) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, options.pollIntervalMs ?? 1_000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const result = await getQrStatus(baseUrl, qr.qrcode, options.fetcher);
    if (result.redirect_host) baseUrl = normalizeBaseUrl(result.redirect_host);
    if (result.status !== lastStatus) {
      lastStatus = result.status;
      options.onStatus?.(result.status === "scaned" ? "已扫码，请在手机上确认" : result.status);
    }
    if (result.status === "confirmed") {
      if (!result.bot_token) throw new Error("微信登录响应缺少 bot token");
      const credentials: WechatCredentials = {
        token: result.bot_token,
        baseUrl: normalizeBaseUrl(result.baseurl || baseUrl),
        accountId: result.ilink_bot_id ?? "",
        userId: result.ilink_user_id ?? "",
        savedAt: new Date().toISOString(),
      };
      await writePrivateJson(wechatCredentialsPath(agentDir, channel.id), credentials);
      await rm(wechatStatePath(agentDir, channel.id), { force: true });
      return credentials;
    }
    if (result.status === "expired") {
      refreshes += 1;
      if (refreshes >= 3) throw new Error("微信登录二维码多次过期，请重试");
      qr = await getQr(baseUrl, options.fetcher);
      options.onQr?.(await renderQr(qr.qrcode_img_content), qr.qrcode_img_content);
      lastStatus = "";
    }
  }
  throw new DOMException("Aborted", "AbortError");
}

async function acquireLock(path: string, instanceId: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const attempt = async (): Promise<boolean> => {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, instanceId, createdAt: new Date().toISOString() }));
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (await attempt()) return true;
  const existing = await readJson<{ pid?: number }>(path).catch(() => undefined);
  if (!existing?.pid) {
    await rm(path, { force: true });
    return attempt();
  }
  try {
    process.kill(existing.pid, 0);
    return false;
  } catch {
    await rm(path, { force: true });
    return attempt();
  }
}

async function releaseLock(path: string, instanceId: string): Promise<void> {
  const existing = await readJson<{ instanceId?: string }>(path).catch(() => undefined);
  if (existing?.instanceId === instanceId) await rm(path, { force: true });
}

function incomingText(raw: RawWechatMessage): string {
  const parts: string[] = [];
  for (const item of raw.item_list ?? []) {
    const quote = item.ref_msg?.message_item?.text_item?.text?.trim();
    const value = item.text_item?.text?.trim() || item.voice_item?.text?.trim();
    if (quote) parts.push(`[引用: ${quote}]`);
    if (value) parts.push(value);
  }
  return parts.join("\n").trim();
}

function incomingImages(raw: RawWechatMessage): {
  declared: number;
  references: WechatImageReference[];
} {
  let declared = 0;
  const references: WechatImageReference[] = [];
  for (const item of raw.item_list ?? []) {
    const image = item.image_item;
    if (item.type !== 2 && !image) continue;
    declared += 1;
    const media = image?.media;
    const fullUrl = media?.full_url?.trim() || image?.url?.trim();
    const encryptedQuery = media?.encrypt_query_param?.trim();
    const url = fullUrl || (encryptedQuery ? buildWechatCdnDownloadUrl(encryptedQuery) : undefined);
    if (!url) continue;
    const aesKey = image?.aeskey?.trim() || media?.aes_key?.trim();
    references.push({ url, ...(aesKey ? { aesKey } : {}) });
  }
  return { declared, references };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function splitText(content: string, max = 1_200): string[] {
  const result: string[] = [];
  let rest = content.trim();
  while (rest.length > max) {
    let index = Math.max(rest.lastIndexOf("\n", max), rest.lastIndexOf(" ", max));
    if (index < Math.floor(max / 2)) index = max;
    result.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) result.push(rest);
  return result;
}

async function sendWechatText(input: {
  channelName: string;
  credentials: WechatCredentials;
  state: WechatPersistedState;
  content: string;
  replyTarget?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  const userId = input.replyTarget || input.state.lastUserId;
  if (!userId) throw new Error(`微信 Channel "${input.channelName}" 尚未收到联系人消息，无法确定接收人`);
  const contextToken = input.state.contextTokens[userId];
  if (!contextToken) throw new Error(`微信 Channel "${input.channelName}" 缺少接收人的 context token`);
  for (const part of splitText(input.content)) {
    await apiPost(
      input.credentials.baseUrl,
      "/ilink/bot/sendmessage",
      input.credentials.token,
      {
        msg: {
          from_user_id: "",
          to_user_id: userId,
          client_id: randomUUID(),
          message_type: 2,
          message_state: 2,
          context_token: contextToken,
          item_list: [{ type: 1, text_item: { text: part } }],
        },
        base_info: baseInfo(),
      },
      { timeoutMs: 15_000, fetcher: input.fetcher, signal: input.signal },
    );
  }
}

async function sendWechatImage(input: {
  channelName: string;
  credentials: WechatCredentials;
  state: WechatPersistedState;
  path: string;
  replyTarget?: string;
  content?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<void> {
  const userId = input.replyTarget || input.state.lastUserId;
  if (!userId) throw new Error(`微信 Channel "${input.channelName}" 尚未收到联系人消息，无法确定接收人`);
  const contextToken = input.state.contextTokens[userId];
  if (!contextToken) throw new Error(`微信 Channel "${input.channelName}" 缺少接收人的 context token`);
  if ((input.content?.length ?? 0) > 1_200) throw new Error("图片附带文字最多 1200 字符，请将长文本单独发送");
  const image = await prepareWechatImage(input.path, input.signal);
  const options = { fetcher: input.fetcher, signal: input.signal };
  const upload = await apiPost<{ upload_param?: string; upload_full_url?: string }>(
    input.credentials.baseUrl, "/ilink/bot/getuploadurl", input.credentials.token,
    {
      filekey: image.filekey, media_type: 1, to_user_id: userId,
      rawsize: image.rawSize, rawfilemd5: image.rawMd5, filesize: image.encrypted.length,
      no_need_thumb: true, aeskey: image.aesKey, base_info: baseInfo(),
    }, { ...options, timeoutMs: 20_000 },
  );
  let uploadParam = upload.upload_param;
  if (!uploadParam && upload.upload_full_url) {
    if (!isTrustedImageUrl(upload.upload_full_url)) throw new Error("微信图片上传地址不在受信任的 CDN 域名内");
    uploadParam = new URL(upload.upload_full_url).searchParams.get("encrypted_query_param") ?? undefined;
  }
  if (!uploadParam) throw new Error("微信图片上传响应缺少 upload_param");
  // Use the fixed trusted CDN; never forward the bot token to it.
  const url = `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${image.filekey}`;
  const timeout = AbortSignal.timeout(60_000);
  const response = await (input.fetcher ?? fetch)(url, {
    method: "POST", headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(image.encrypted), redirect: "error",
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  });
  const downloadParam = response.headers.get("x-encrypted-param");
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`微信图片上传失败: HTTP ${response.status}`);
  if (!downloadParam) throw new Error("微信图片上传响应缺少 x-encrypted-param");
  await apiPost(input.credentials.baseUrl, "/ilink/bot/sendmessage", input.credentials.token, {
    msg: {
      from_user_id: "", to_user_id: userId, client_id: randomUUID(),
      message_type: 2, message_state: 2, context_token: contextToken,
      item_list: [
        { type: 2, image_item: {
          media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(image.aesKey, "utf8").toString("base64"), encrypt_type: 1 },
          mid_size: image.encrypted.length,
        } },
      ],
    }, base_info: baseInfo(),
  }, { ...options, timeoutMs: 15_000 });
  // iLink rejects mixed text/image item_list with "invalid arguments".
  // Send the caption separately and preserve the original image recipient.
  if (input.content?.trim()) {
    try {
      await sendWechatText({
        channelName: input.channelName,
        credentials: input.credentials,
        state: input.state,
        content: input.content,
        replyTarget: userId,
        ...options,
      });
    } catch (error) {
      throw new WechatImageCaptionError(error);
    }
  }
}

export async function startWechatTransport(options: {
  agentDir: string;
  channel: ChannelDefinition;
  instanceId?: string;
  fetcher?: typeof fetch;
  imageMaxBytes?: number;
  onMessage(message: WechatInboundMessage): void | Promise<void>;
  onError?(error: unknown): void;
}): Promise<RunningWechatTransport> {
  const { channel, agentDir } = options;
  const credentials = await readJson<WechatCredentials>(wechatCredentialsPath(agentDir, channel.id));
  if (!credentials?.token) throw new WechatNotLoggedInError(channel.name);

  const instanceId = options.instanceId ?? randomUUID();
  const lockPath = wechatLockPath(agentDir, channel.id);
  if (!(await acquireLock(lockPath, instanceId))) {
    return {
      status: "occupied",
      detail: "消息接收由另一个 Pi 会话持有；本会话可共享发送",
      send: async (content, replyTarget) => {
        const state = await readJson<WechatPersistedState>(wechatStatePath(agentDir, channel.id));
        if (!state) {
          throw new Error(`微信 Channel "${channel.name}" 尚无共享联系人状态，请先让该微信收到一条联系人消息`);
        }
        await sendWechatText({
          channelName: channel.name,
          credentials,
          state,
          content,
          ...(replyTarget ? { replyTarget } : {}),
          ...(options.fetcher ? { fetcher: options.fetcher } : {}),
        });
      },
      sendImage: async (path, replyTarget, content, signal) => {
        const state = await readJson<WechatPersistedState>(wechatStatePath(agentDir, channel.id));
        if (!state) throw new Error(`微信 Channel "${channel.name}" 尚无共享联系人状态`);
        await sendWechatImage({ channelName: channel.name, credentials, state, path, replyTarget, content, signal, fetcher: options.fetcher });
      },
      close: async () => undefined,
    };
  }

  const persisted = await readJson<WechatPersistedState>(wechatStatePath(agentDir, channel.id));
  const state: WechatPersistedState = persisted ?? { cursor: "", contextTokens: {} };
  const abort = new AbortController();
  let closed = false;
  let persistQueue = Promise.resolve();
  const persist = (): void => {
    const snapshot = { ...state, contextTokens: { ...state.contextTokens } };
    persistQueue = persistQueue.catch(() => undefined).then(() => writePrivateJson(wechatStatePath(agentDir, channel.id), snapshot));
  };

  const send = async (content: string, replyTarget?: string): Promise<void> =>
    sendWechatText({
      channelName: channel.name,
      credentials,
      state,
      content,
      ...(replyTarget ? { replyTarget } : {}),
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    });

  const pollTask = (async () => {
    let retryMs = 1_000;
    while (!closed && !abort.signal.aborted) {
      try {
        const response = await apiPost<UpdatesResponse>(
          credentials.baseUrl,
          "/ilink/bot/getupdates",
          credentials.token,
          { get_updates_buf: state.cursor, base_info: baseInfo() },
          { signal: abort.signal, timeoutMs: 40_000, fetcher: options.fetcher },
        );
        state.cursor = response.get_updates_buf || state.cursor;
        retryMs = 1_000;
        for (const raw of response.msgs ?? []) {
          if (raw.message_type !== 1) continue;
          const userId = raw.from_user_id ?? "";
          if (userId && raw.context_token) {
            state.lastUserId = userId;
            state.contextTokens[userId] = raw.context_token;
          }
          let content = incomingText(raw);
          const imageInput = incomingImages(raw);
          const references = imageInput.references.slice(0, MAX_WECHAT_IMAGES_PER_MESSAGE);
          const images: ChannelImage[] = [];
          let imageFailures = imageInput.declared - references.length;
          for (const reference of references) {
            try {
              images.push(await downloadWechatImage(reference, {
                ...(options.fetcher ? { fetcher: options.fetcher } : {}),
                signal: abort.signal,
                maxBytes: options.imageMaxBytes ?? DEFAULT_WECHAT_IMAGE_MAX_BYTES,
              }));
            } catch (error) {
              imageFailures += 1;
              options.onError?.(error);
            }
          }
          if (images.length > 0 && !content) {
            content = images.length === 1
              ? "用户通过微信发送了一张图片，请分析图片内容。"
              : `用户通过微信发送了 ${images.length} 张图片，请分析图片内容。`;
          }
          if (imageFailures > 0) {
            const failureNote = `[${imageFailures} 张微信图片下载、解密或格式校验失败]`;
            content = content ? `${content}\n\n${failureNote}` : failureNote;
          }
          if (!userId || (!content && images.length === 0)) continue;
          await options.onMessage({
            id: String(raw.message_id || randomUUID()),
            userId,
            content,
            ...(images.length > 0 ? { images } : {}),
            receivedAt: new Date(raw.create_time_ms ?? Date.now()).toISOString(),
          });
        }
        persist();
      } catch (error) {
        if (abort.signal.aborted) break;
        options.onError?.(error);
        const code = (error as { code?: unknown }).code;
        if (code === -14) break;
        await abortableDelay(retryMs, abort.signal);
        retryMs = Math.min(30_000, retryMs * 2);
      }
    }
  })();

  return {
    status: "connected",
    send,
    sendImage: (path, replyTarget, content, signal) => sendWechatImage({
      channelName: channel.name, credentials, state, path, replyTarget, content, signal, fetcher: options.fetcher,
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      abort.abort();
      await pollTask.catch(() => undefined);
      await persistQueue.catch(() => undefined);
      await releaseLock(lockPath, instanceId);
    },
  };
}
