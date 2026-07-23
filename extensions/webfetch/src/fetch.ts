/**
 * The webfetch network pipeline: validate → cache → fetch (manual redirects) →
 * size-cap → content-type branch → HTML→markdown → char-truncate → cache.
 *
 * Redirects are handled MANUALLY (`redirect: "manual"`): only same-origin hops
 * are auto-followed (see {@link isPermittedRedirect}); a cross-host redirect is
 * NOT chased — instead a "REDIRECT DETECTED" notice is returned so the model
 * re-issues webfetch with the new URL. This closes the SSRF-via-open-redirect
 * hole. Bodies are read through a capped stream reader so a multi-GB response is
 * never pulled fully into memory.
 *
 * DNS SSRF GUARD: {@link checkUrl} only validates the URL *string*, so a public
 * hostname whose A/AAAA record points at an internal address (e.g.
 * `metadata.attacker.com → 169.254.169.254`) would otherwise slip through and let
 * `fetch` connect to the internal host. Before every request (initial + each
 * followed redirect) we resolve the host and reject if ANY resolved address is
 * private/internal. This closes the "static internal DNS record" variant. It does
 * NOT fully close DNS-rebinding TOCTOU: the platform `fetch` re-resolves the name
 * at socket-connect time, so an attacker who controls DNS and flips the answer
 * between our lookup and fetch's can still win. Fully closing that requires pinning
 * the connection to the validated IP (a custom undici dispatcher / connect hook),
 * which the injected-global-`fetch` design here does not expose — see the audit note.
 */

import type { WebFetchConfig } from "./config.js";
import { htmlToMarkdown, looksLikeHtml } from "./html.js";
import type { TtlCache } from "./cache.js";
import { checkUrl, isPermittedRedirect, isIpLiteral, isPrivateAddress } from "./validate.js";

/** Cap same-host redirect hops (matches common client defaults). */
export const MAX_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Structured result of a fetch. Also the cached value (minus the prompt intent). */
export interface WebFetchResult {
  /** The URL as originally requested (cache key, http not upgraded). */
  url: string;
  /** HTTP status code (or redirect status for a cross-host notice). */
  code: number;
  /** Bytes read from the response body (post size-cap). */
  bytes: number;
  /** Extracted markdown / text / binary-placeholder / redirect notice. */
  result: string;
  /** Response content-type (lowercased, may be empty). */
  contentType: string;
  /** True if at least one same-host redirect was followed. */
  redirected: boolean;
  /** True if the body was cut off by the byte or char cap. */
  truncated: boolean;
}

/** Minimal shape we need from a fetch Response (real Response satisfies this). */
export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Injectable fetch (defaults to global fetch); lets tests supply a fake. */
export type FetchImpl = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<FetchResponseLike>;

/**
 * Resolve a DNS hostname to its concrete IP addresses. Injectable so tests can
 * supply a deterministic resolver (and so the pure network layer never does real
 * DNS in unit tests). Defaults to {@link defaultResolveHost}.
 */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** Real DNS resolver: node:dns lookup returning every A/AAAA address. */
async function defaultResolveHost(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export interface FetchOptions {
  config: WebFetchConfig;
  cache?: TtlCache<WebFetchResult>;
  signal?: AbortSignal;
  now?: () => number;
  fetchImpl?: FetchImpl;
  /**
   * DNS resolver used by the connect-time SSRF guard. If omitted: real DNS is used
   * when `fetchImpl` is not injected (production path); when a fake `fetchImpl` is
   * injected without a resolver the guard is skipped (unit-test path — inject a
   * `resolveHost` to exercise it).
   */
  resolveHost?: ResolveHost;
}

/** Content types treated as binary → not decoded, only a placeholder is returned. */
const BINARY_APPLICATION_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-bzip2",
  "application/octet-stream",
  "application/wasm",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * Decide whether a content-type should be treated as opaque binary. text/*,
 * JSON/XML/JS, and any `+json`/`+xml` structured type are textual; images,
 * audio, video, fonts, and the known binary application types are not. Unknown
 * `application/*` is decoded as text (many text formats live there).
 */
export function isBinaryContentType(contentType: string): boolean {
  const t = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!t) return false;
  if (t.startsWith("text/")) return false;
  if (t === "application/json" || t === "application/xml" || t === "application/xhtml+xml") return false;
  if (t === "application/javascript" || t === "application/ecmascript") return false;
  if (t.endsWith("+json") || t.endsWith("+xml")) return false;
  if (t.startsWith("image/") || t.startsWith("audio/") || t.startsWith("video/") || t.startsWith("font/")) return true;
  return BINARY_APPLICATION_TYPES.has(t);
}

/** Merge an external abort signal with a fresh timeout into one signal. */
function mergeSignal(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("webfetch: request timed out")), timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** Concatenate collected chunks into a single Uint8Array of exactly `total` bytes. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Read a response body but never more than `maxBytes`. Prefers the streaming
 * reader (so a huge body is aborted early); falls back to arrayBuffer() for
 * fakes / bodiless responses.
 */
async function readBodyCapped(
  response: FetchResponseLike,
  maxBytes: number,
): Promise<{ data: Uint8Array; truncated: boolean }> {
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          /* best effort */
        }
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    return { data: concatChunks(chunks, total), truncated };
  }

  if (typeof response.arrayBuffer === "function") {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > maxBytes) return { data: buf.subarray(0, maxBytes), truncated: true };
    return { data: buf, truncated: false };
  }

  return { data: new Uint8Array(0), truncated: false };
}

/** Byte length of a UTF-8 string without pulling in Buffer typings everywhere. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Connect-time SSRF guard: resolve `url`'s host and throw if it resolves to a
 * private/internal address. IP literals are skipped — they were already
 * range-checked by {@link checkUrl}/{@link isPermittedRedirect}. Fails CLOSED:
 * an unresolvable host, an empty answer, or any private address in the answer
 * set all throw, so a name that resolves to both a public and a private address
 * (a rebinding tell) is refused.
 */
async function assertResolvesPublic(url: string, resolveHost: ResolveHost): Promise<void> {
  const host = new URL(url).hostname;
  if (isIpLiteral(host)) return;
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    throw new Error(`webfetch: could not resolve host ${host}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new Error(`webfetch: host ${host} did not resolve to any address`);
  }
  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new Error(`webfetch: refusing to fetch ${host} — it resolves to an internal/private address (${addr})`);
    }
  }
}

/**
 * Fetch a URL and return extracted content. Throws on validation failure or a
 * transport error; returns a normal result (never throws) for HTTP error codes
 * and for cross-host redirects (a "REDIRECT DETECTED" notice).
 */
export async function fetchAndExtract(inputUrl: string, opts: FetchOptions): Promise<WebFetchResult> {
  const { config, cache, now = () => Date.now(), fetchImpl } = opts;
  const doFetch: FetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, init) as Promise<FetchResponseLike>);
  // Real DNS on the production path; skipped for a fake fetch unless a resolver
  // is injected (so unit tests do no real DNS but can still exercise the guard).
  const resolveHost: ResolveHost | undefined = opts.resolveHost ?? (fetchImpl ? undefined : defaultResolveHost);

  const check = checkUrl(inputUrl);
  if (!check.ok) throw new Error(`webfetch: ${check.reason}`);

  const cached = cache?.get(inputUrl, now(), config.cacheMs);
  if (cached) return cached;

  const { signal, cleanup } = mergeSignal(opts.signal, config.timeoutMs);
  try {
    let current = check.url; // https-upgraded
    let hops = 0;

    for (;;) {
      // Connect-time SSRF guard: block hosts that resolve to internal addresses,
      // for the initial URL and for every same-host redirect target alike.
      if (resolveHost) await assertResolvesPublic(current, resolveHost);

      const response = await doFetch(current, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "text/markdown, text/html, application/json, text/plain, */*",
          "User-Agent": config.userAgent,
        },
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`webfetch: redirect ${response.status} missing Location header`);
        const nextUrl = new URL(location, current).toString();

        if (isPermittedRedirect(current, nextUrl)) {
          hops += 1;
          if (hops > MAX_REDIRECTS) throw new Error(`webfetch: too many redirects (exceeded ${MAX_REDIRECTS})`);
          current = nextUrl;
          continue;
        }

        // Cross-host redirect: surface it, do not follow (SSRF guard). Not cached.
        const notice = `REDIRECT DETECTED: ${nextUrl} — call webfetch again with the new URL. Cross-host redirects are not followed automatically for security.`;
        return {
          url: inputUrl,
          code: response.status,
          bytes: utf8ByteLength(notice),
          result: notice,
          contentType: "",
          redirected: true,
          truncated: false,
        };
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const { data, truncated: sizeTruncated } = await readBodyCapped(response, config.maxBytes);
      const bytes = data.length;

      let result: string;
      let charTruncated = false;
      if (isBinaryContentType(contentType)) {
        result = `[Binary content (${contentType || "unknown type"}, ${bytes} bytes) not fetched]`;
      } else {
        const decoded = new TextDecoder("utf-8", { fatal: false }).decode(data);
        const isHtml = contentType.includes("text/html") || (!contentType && looksLikeHtml(decoded));
        let extracted = isHtml ? htmlToMarkdown(decoded) : decoded;
        if (extracted.length > config.maxChars) {
          extracted = `${extracted.slice(0, config.maxChars)}\n\n… [truncated]`;
          charTruncated = true;
        }
        result = extracted;
      }

      const out: WebFetchResult = {
        url: inputUrl,
        code: response.status,
        bytes,
        result,
        contentType,
        redirected: hops > 0,
        truncated: sizeTruncated || charTruncated,
      };
      cache?.set(inputUrl, out, now());
      return out;
    }
  } finally {
    cleanup();
  }
}
