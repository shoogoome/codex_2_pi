import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export interface DotsWebhookRequest {
  url: string;
  secrets: string[];
  subscriptionId: string;
  id: string;
  payload: unknown;
  signal?: AbortSignal;
}

export interface DotsWebhookResponse { status: number; body: string }
export type DotsWebhookSender = (request: DotsWebhookRequest) => Promise<DotsWebhookResponse>;

export function decodeDotsSigningSecret(secret: unknown): Buffer {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid webhook signing secret");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("Invalid webhook signing secret");
  return key;
}

export function dotsWebhookSignature(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${createHmac("sha256", decodeDotsSigningSecret(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function dotsCallbackUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 4096) throw new Error("Callback must be a public HTTPS URL");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Callback must be a public HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) throw new Error("Callback must be a public HTTPS URL without credentials or fragment");
  return url;
}

/** Conservative public-only addresses: mapped IPv6, transition and reserved ranges are not destinations. */
export function isPublicDotsAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes(".")) return false;
  const parts = address.toLowerCase().split(":");
  const first = Number.parseInt(parts[0] || "0", 16);
  if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
  // IETF protocol-assignment block (including Teredo), documentation and benchmarking.
  const second = Number.parseInt(parts[1] || "0", 16);
  if (first === 0x2001 && (second < 0x200 || second === 0xdb8)) return false;
  if (first === 0x3fff && second < 0x1000) return false;
  return true;
}

export interface DotsWebhookDependencies {
  lookup?: typeof dnsLookup;
  request?: typeof httpsRequest;
  now?: () => number;
  timeoutMs?: number;
}

/** Resolve each connection, reject every non-public answer, and pin the validated address in TLS lookup. */
export function createDotsWebhookSender(deps: DotsWebhookDependencies = {}): DotsWebhookSender {
  const lookup = deps.lookup ?? dnsLookup;
  const request = deps.request ?? httpsRequest;
  return async (input) => {
    const url = dotsCallbackUrl(input.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literal = isIP(hostname);
    const answers = literal ? [{ address: hostname, family: literal }] : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: Array<{ address: string; family: number }>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = (): void => finish(new Error("Webhook delivery cancelled"));
      const timer = setTimeout(() => finish(new Error("Webhook DNS timeout")), deps.timeoutMs ?? 10_000);
      timer.unref?.();
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) { abort(); return; }
      void lookup(hostname, { all: true, verbatim: true }).then((value) => finish(undefined, value), (error: Error) => finish(error));
    });
    if (!answers.length || answers.some((answer) => !isPublicDotsAddress(answer.address))) throw new Error("Callback destination is not public");
    if (input.signal?.aborted) throw new Error("Webhook delivery cancelled");
    const address = answers[0]!;
    const body = JSON.stringify(input.payload);
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Webhook payload exceeds 256 KiB");
    const timestamp = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const signatures = input.secrets.map((secret) => dotsWebhookSignature(secret, input.id, timestamp, body)).join(" ");
    return new Promise<DotsWebhookResponse>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: DotsWebhookResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const req = request(url, {
        method: "POST", servername: literal ? undefined : hostname,
        // Never resolve again at connect time: pins this public DNS result while retaining hostname TLS verification.
        lookup: ((_host: string, opts: unknown, callback: (...args: unknown[]) => void) => {
          if (typeof opts === "object" && opts !== null && "all" in opts && opts.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as NonNullable<Parameters<typeof httpsRequest>[1]>["lookup"],
        headers: {
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
          "webhook-id": input.id, "webhook-timestamp": String(timestamp),
          "webhook-signature": signatures, "X-MCP-Subscription-Id": input.subscriptionId,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > 64 * 1024) { res.destroy(); req.destroy(new Error("Webhook response exceeds limit")); return; }
          chunks.push(chunk);
        });
        res.once("end", () => finish(undefined, { status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString("utf8") }));
        res.once("error", (error) => finish(error));
      });
      const abort = (): void => { req.destroy(new Error("Webhook delivery cancelled")); };
      const timer = setTimeout(() => req.destroy(new Error("Webhook delivery timeout")), deps.timeoutMs ?? 10_000);
      timer.unref?.();
      req.once("error", (error) => finish(error));
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      req.end(body);
    });
  };
}
