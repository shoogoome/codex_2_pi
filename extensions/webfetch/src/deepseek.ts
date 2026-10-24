/**
 * DeepSeek Search / Fetch API client.
 *
 * Both endpoints are plain JSON-over-HTTP with the same `Bearer` auth as the
 * chat API (see https://api-docs.deepseek.com/zh-cn/guides/search):
 *
 *   POST {base}/v1/tools/search  { query, count, need_content, ori_question, localization }
 *   POST {base}/v1/tools/fetch   { url }
 *
 * Design notes that matter for the agent loop:
 *   - `search` returns raw result objects; {@link formatSearchResults} turns them
 *     into the compact, model-readable listing (title / url / date / short
 *     summary) that keeps the prompt small. `content` is only appended when the
 *     caller explicitly asked for it AND a per-result character cap is applied,
 *     because 8 results × full page bodies would blow the context window.
 *   - Errors are mapped to readable messages (401 bad key, 402 balance, 403
 *     blocked by policy, 404 no extractable content, 429 rate limit) with a
 *     `retryable` flag, so the tool can retry transient failures (408/429/5xx)
 *     and surface permanent ones verbatim.
 *   - Fetch's `content` is already Markdown, so it bypasses the local HTML
 *     converter entirely.
 *
 * The HTTP call is injectable (`FetchImpl`) so unit tests never touch the network.
 */

import type { FetchImpl, FetchResponseLike } from "./fetch.js";
import { DEFAULT_RETRY, type RetryPolicy, isRetryableStatus, mergeSignal, withRetry } from "./request.js";

/** DeepSeek Search caps a single query at 128 Unicode characters. */
export const MAX_QUERY_LENGTH = 128;

/** One entry of the Search response `results` array. */
export interface DeepSeekSearchResult {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string | null;
  site_icon?: string | null;
  date?: string | null;
  authority?: number;
}

export interface DeepSeekSearchResponse {
  results?: DeepSeekSearchResult[];
}

export interface DeepSeekFetchResponse {
  title?: string;
  content?: string;
}

/** Options for one search request. */
export interface SearchRequestOptions {
  query: string;
  /** Result count (1–50). DeepSeek's own default is 10. */
  count?: number;
  /** Ask for full page bodies in `content` (default false). */
  needContent?: boolean;
  /** The user's original question — improves intent understanding. */
  oriQuestion?: string;
  /** IP address used to prefer localized results. */
  localization?: string;
  /** Overrides config; required for a real request. */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  retry?: RetryPolicy;
  /** Overridable sleep used by retry backoff (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Options for one fetch request. */
export interface FetchPageOptions {
  url: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  retry?: RetryPolicy;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Error raised for any DeepSeek API failure, carrying the HTTP status. */
export class DeepSeekApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "DeepSeekApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

/** Human-readable reason for a DeepSeek HTTP status code. */
export function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return "请求参数不合法（400）";
    case 401:
      return "DeepSeek API Key 缺失或无效（401），请设置 DEEPSEEK_API_KEY";
    case 402:
      return "DeepSeek 账号余额不足（402）";
    case 403:
      return "请求被安全策略拒绝（403）";
    case 404:
      return "未能获取可用的网页内容（404）：URL 不可用、被站点策略拦截或没有可提取的正文";
    case 408:
      return "读取请求体超时（408）";
    case 413:
      return "请求体超过大小限制（413）";
    case 429:
      return "超过 DeepSeek Search/Fetch 的 QPS 限制（429）";
    case 500:
      return "DeepSeek 服务器内部错误（500）";
    case 504:
      return "DeepSeek 下游请求超时（504）";
    default:
      return `DeepSeek API 返回 HTTP ${status}`;
  }
}

/** Trim and bound a query to the API's 128-character limit. */
export function normalizeQuery(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_QUERY_LENGTH ? trimmed.slice(0, MAX_QUERY_LENGTH) : trimmed;
}

/** Build the absolute endpoint URL for a tool path (`v1/tools/<name>`). */
export function toolEndpoint(baseUrl: string, name: "search" | "fetch"): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v1/tools/${name}`;
}

/** Read a response body as text, tolerating fakes that only expose arrayBuffer(). */
async function readResponseText(response: FetchResponseLike): Promise<string> {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  if (typeof response.arrayBuffer === "function") {
    return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(await response.arrayBuffer()));
  }
  return "";
}

/** Pull the OpenAI-compatible `error.message` out of an error body, if present. */
function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    /* not JSON — fall through */
  }
  return "";
}

/** POST JSON to a DeepSeek tool endpoint and parse the JSON reply. */
async function postJson<T>(
  url: string,
  payload: unknown,
  opts: {
    apiKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetchImpl?: FetchImpl;
    retry?: RetryPolicy;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    label: string;
  },
): Promise<T> {
  const apiKey = opts.apiKey?.trim();
  if (!apiKey) {
    throw new DeepSeekApiError("DeepSeek API Key 缺失：请设置 DEEPSEEK_API_KEY 环境变量", 401, false);
  }
  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, init) => globalThis.fetch(u, init) as Promise<FetchResponseLike>);
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...opts.retry, sleep: opts.sleep ?? opts.retry?.sleep };

  return withRetry(
    async () => {
      const { signal, cleanup } = mergeSignal(opts.signal, opts.timeoutMs ?? 60_000, opts.label);
      try {
        const response = await doFetch(url, {
          redirect: "manual",
          signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
          method: "POST",
        });
        const body = await readResponseText(response);
        if (response.status !== 200) {
          const detail = errorDetail(body);
          const message = detail ? `${describeStatus(response.status)}: ${detail}` : describeStatus(response.status);
          throw new DeepSeekApiError(message, response.status, isRetryableStatus(response.status));
        }
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new DeepSeekApiError(`${opts.label}: DeepSeek 返回了非 JSON 响应`, response.status, false);
        }
      } finally {
        cleanup();
      }
    },
    (err) => err instanceof DeepSeekApiError && err.retryable,
    policy,
    opts.signal,
  );
}

/** Run a DeepSeek web search. Returns the raw `results` array (possibly empty). */
export async function searchWeb(opts: SearchRequestOptions): Promise<DeepSeekSearchResult[]> {
  const query = normalizeQuery(opts.query);
  if (query.length === 0) throw new DeepSeekApiError("搜索词不能为空", 400, false);

  const payload: Record<string, unknown> = { query };
  if (opts.count !== undefined) payload.count = Math.min(50, Math.max(1, Math.floor(opts.count)));
  if (opts.needContent !== undefined) payload.need_content = opts.needContent;
  if (opts.oriQuestion && opts.oriQuestion.trim().length > 0) payload.ori_question = opts.oriQuestion.trim().slice(0, 128);
  if (opts.localization && opts.localization.trim().length > 0) payload.localization = opts.localization.trim();

  const json = await postJson<DeepSeekSearchResponse>(
    toolEndpoint(opts.baseUrl ?? "https://api.deepseek.com", "search"),
    payload,
    {
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      retry: opts.retry,
      sleep: opts.sleep,
      label: "webfetch search",
    },
  );
  return Array.isArray(json.results) ? json.results : [];
}

/** Fetch one page through DeepSeek (returns Markdown, handles JS-rendered pages). */
export async function fetchPageViaDeepSeek(opts: FetchPageOptions): Promise<{ title: string; content: string }> {
  const json = await postJson<DeepSeekFetchResponse>(
    toolEndpoint(opts.baseUrl ?? "https://api.deepseek.com", "fetch"),
    { url: opts.url },
    {
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
      retry: opts.retry,
      sleep: opts.sleep,
      label: "webfetch fetch",
    },
  );
  return {
    title: typeof json.title === "string" ? json.title : "",
    content: typeof json.content === "string" ? json.content : "",
  };
}

/** Compact a date to `YYYY-MM-DD` (drops the noisy RFC 3339 time/offset). */
export function shortDate(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw.trim();
}

/** Trim trailing whitespace and collapse runs of blank lines (markdown hygiene). */
export function tidyMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clamp a block of text to `maxChars`, appending a truncation marker. */
export function clampText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n… [truncated]`, truncated: true };
}

export interface FormatSearchOptions {
  /** Optional label printed above the result list (the query or queries used). */
  queryLabel?: string;
  /** Include `content` blocks (only meaningful when need_content was requested). */
  includeContent?: boolean;
  /** Per-result content character cap. */
  contentChars?: number;
  /** Overall character cap for the whole formatted listing. */
  maxChars?: number;
}

/** Label used for one search result ("S1", "S2", …) — the ref_id prefix. */
export function resultLabel(index: number): string {
  return `S${index + 1}`;
}

/**
 * Format DeepSeek search results as the model-facing listing. Each entry shows
 * its stable label (`[S1]`) so the model can point back at it, then title, URL,
 * date/site metadata, the long summary (best for model reading), and optionally
 * a clamped slice of the page content.
 */
export function formatSearchResults(results: DeepSeekSearchResult[], options: FormatSearchOptions = {}): string {
  const contentChars = options.contentChars ?? 2_000;
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY;
  const header = options.queryLabel ? `Search results for: ${options.queryLabel}\n\n` : "";
  if (results.length === 0) {
    return `${header}No web results found. Try a broader or differently worded query.`;
  }

  const blocks: string[] = [];
  results.forEach((result, index) => {
    const label = resultLabel(index);
    const title = (result.title ?? "").trim() || "(untitled)";
    const url = (result.url ?? "").trim();
    const date = shortDate(result.date);
    const site = (result.site_name ?? "").trim();

    const metaParts: string[] = [];
    if (site) metaParts.push(site);
    if (date) metaParts.push(date);
    if (typeof result.authority === "number" && result.authority >= 3) metaParts.push("authoritative");
    const meta = metaParts.length > 0 ? ` (${metaParts.join(", ")})` : "";

    const lines = [`[${label}] ${title}${meta}`, url ? `URL: ${url}` : "URL: (missing)"];

    const body = (result.summary ?? "").trim() || (result.snippet ?? "").trim();
    if (body) lines.push("", body);

    if (options.includeContent) {
      const content = tidyMarkdown(result.content ?? "");
      if (content.length > 0) {
        const clamped = clampText(content, contentChars);
        lines.push("", "Content:", clamped.text);
      }
    }
    blocks.push(lines.join("\n"));
  });

  const joined = blocks.join("\n\n---\n\n");
  const clamped = clampText(joined, maxChars);
  const footer = "\n\nCite results by title with a Markdown link to their URL; refs like [S1] are for follow-up calls only, never for the final answer.";
  return header + clamped.text + footer;
}
