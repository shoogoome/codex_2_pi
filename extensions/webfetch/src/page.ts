/**
 * Page-mode orchestration: local pipeline first, DeepSeek Fetch as the backup.
 *
 * The local pipeline (see {@link fetchAndExtract}) is free, never leaves our
 * process for anything but the target page, and preserves the SSRF guard. It
 * cannot, however, run JavaScript, and modern docs sites / SPAs / paywalled
 * article shells routinely return a 200 with a few hundred bytes of chrome and
 * no prose. DeepSeek Fetch renders and extracts server-side and returns clean
 * Markdown, so it is the right second attempt — but only the second one, because
 * it costs a billed request per call.
 *
 * `config.deepseekFetch` selects the strategy:
 *   - `auto`   local first, DeepSeek only when local extraction is unusable
 *   - `always` DeepSeek first, local as the fallback for API failures
 *   - `off`    local only (no API key needed at all)
 */

import type { WebFetchConfig } from "./config.js";
import { fetchPageViaDeepSeek, clampText } from "./deepseek.js";
import { type FetchImpl, type ResolveHost, type WebFetchResult, fetchAndExtract } from "./fetch.js";
import type { TtlCache } from "./cache.js";
import { checkUrl } from "./validate.js";

/**
 * Below this many characters of extracted text (and with a 2xx status), a page
 * is treated as "rendered to nothing" and DeepSeek Fetch gets a shot.
 */
export const MIN_LOCAL_TEXT_CHARS = 200;

/** DeepSeek Fetch timeout: server-side rendering is slower than a plain GET. */
export const DEEPSEEK_FETCH_TIMEOUT_MS = 90_000;

export interface PageOptions {
  url: string;
  config: WebFetchConfig;
  cache?: TtlCache<WebFetchResult>;
  signal?: AbortSignal;
  now?: () => number;
  /** Injected local fetch (tests). */
  fetchImpl?: FetchImpl;
  /** Injected DNS resolver for the local SSRF guard (tests). */
  resolveHost?: ResolveHost;
  /** Injected DeepSeek fetch (tests). */
  deepseekFetchImpl?: FetchImpl;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** True when the local result is too thin / too broken to hand to the model. */
export function needsRemoteFallback(result: WebFetchResult): boolean {
  if (result.code >= 400) return true;
  const body = result.result ?? "";
  if (body.startsWith("[Binary content")) return true;
  // A cross-host redirect notice is a deliberate answer, not a failure.
  if (body.startsWith("REDIRECT DETECTED:")) return false;
  return body.trim().length < MIN_LOCAL_TEXT_CHARS;
}

/** Run one DeepSeek Fetch request and shape it into a {@link WebFetchResult}. */
async function tryDeepSeekFetch(url: string, opts: PageOptions): Promise<WebFetchResult | undefined> {
  const apiKey = opts.config.deepseekApiKey;
  if (!apiKey) return undefined;
  // DeepSeek fetches from ITS network, not ours, so this never became an SSRF
  // pivot — but an internal/intranet URL must still never be handed to a third
  // party. `always` mode reaches here BEFORE the local pipeline validates, so the
  // check has to happen here too (not just inside fetchAndExtract).
  if (!checkUrl(url).ok) return undefined;
  try {
    const page = await fetchPageViaDeepSeek({
      url,
      apiKey,
      baseUrl: opts.config.deepseekBaseUrl,
      timeoutMs: DEEPSEEK_FETCH_TIMEOUT_MS,
      signal: opts.signal,
      fetchImpl: opts.deepseekFetchImpl,
      sleep: opts.sleep,
    });
    const content = page.content.trim();
    if (content.length === 0) return undefined;
    const clamped = clampText(content, opts.config.maxChars);
    return {
      url,
      code: 200,
      bytes: content.length,
      result: clamped.text,
      contentType: "text/markdown",
      redirected: false,
      truncated: clamped.truncated,
      via: "deepseek",
      title: page.title || undefined,
    };
  } catch {
    // A DeepSeek failure must not cost the caller the local result.
    return undefined;
  }
}

/**
 * Load one page: honour `deepseekFetch`, keep the local pipeline authoritative
 * for SSRF-sensitive targets, and always return something usable when possible.
 * Throws only when BOTH pipelines fail and there is nothing to report.
 */
export async function loadPage(opts: PageOptions): Promise<WebFetchResult> {
  const mode = opts.config.deepseekFetch;
  const hasKey = typeof opts.config.deepseekApiKey === "string" && opts.config.deepseekApiKey.length > 0;
  const now = () => opts.now?.() ?? Date.now();

  // Serve a cached page before touching either pipeline: this is what keeps a
  // repeated read of a DeepSeek-rescued page from costing a second billed call.
  const cached = opts.cache?.get(opts.url, now(), opts.config.cacheMs);
  if (cached) return cached;

  if (mode === "off" || !hasKey) return runLocal(opts);

  // `always`: DeepSeek renders server-side (JS-heavy sites), local as the fallback.
  if (mode === "always") {
    const remote = await tryDeepSeekFetch(opts.url, opts);
    if (!remote) return runLocal(opts);
    opts.cache?.set(opts.url, remote, now());
    return remote;
  }

  // `auto` (default): the free local pipeline first, DeepSeek only if it failed.
  const local = await runLocal(opts);
  if (!needsRemoteFallback(local)) return local;

  const remote = await tryDeepSeekFetch(opts.url, opts);
  if (!remote) return local;

  const merged: WebFetchResult = {
    ...remote,
    // Keep the local HTTP status so the caller can still see what the origin said
    // (e.g. 403 → DeepSeek rendered the article anyway).
    code: local.code,
    redirected: local.redirected,
  };
  opts.cache?.set(opts.url, merged, now());
  return merged;
}

/** Run the local fetch pipeline with this request's injections. */
function runLocal(opts: PageOptions): Promise<WebFetchResult> {
  return fetchAndExtract(opts.url, {
    config: opts.config,
    cache: opts.cache,
    signal: opts.signal,
    now: opts.now,
    fetchImpl: opts.fetchImpl,
    resolveHost: opts.resolveHost,
  });
}
