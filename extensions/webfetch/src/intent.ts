/**
 * Decide what the model actually asked for in one `webfetch` call.
 *
 * Codex exposes search and page opening as commands inside a single `web.run`
 * tool. We keep one tool too, and instead of a mode enum we accept the `url`
 * argument loosely:
 *
 *   - a real URL                      → page mode
 *   - `https://duckduckgo.com/?q=…`   → search mode (query extracted)
 *     `https://www.google.com/search?q=…`, `https://cn.bing.com/search?q=…`, …
 *   - a bare phrase without a scheme  → search mode (the phrase is the query)
 *
 * Models routinely paste a search-engine URL when they mean "search", so
 * normalizing that here is worth much more than a strict parse error. A string
 * WITH a scheme is always page mode: a typo'd host must fail loudly rather than
 * silently turn into a web search.
 *
 * Pure and synchronous → trivially unit-testable.
 */

import { MAX_QUERY_LENGTH } from "./deepseek.js";

export type WebFetchPlan =
  | { mode: "search"; query: string }
  | { mode: "page"; url: string }
  | { mode: "error"; message: string };

/** Hosts whose `?q=` style URLs mean "run a search", not "fetch this page". */
const SEARCH_ENGINE_HOSTS = new Set([
  "duckduckgo.com",
  "www.duckduckgo.com",
  "html.duckduckgo.com",
  "lite.duckduckgo.com",
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "cn.bing.com",
  "baidu.com",
  "www.baidu.com",
  "search.brave.com",
  "search.yahoo.com",
  "www.ecosia.org",
  "ecosia.org",
  "www.sogou.com",
  "sogou.com",
  "www.so.com",
  "so.com",
]);

/** Query parameter names used by the engines above. */
const SEARCH_PARAM_NAMES = ["q", "query", "wd", "p", "text"];

/** Strip the surrounding brackets/punctuation a model may wrap a query in. */
function cleanQuery(raw: string): string {
  return raw.trim().replace(/^["'`]+/, "").replace(/["'`]+$/, "").replace(/\s+/g, " ");
}

/** Extract the search term from a search-engine URL, or null if it isn't one. */
export function queryFromSearchUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\d*\./, "www.").replace(/\.$/, "");
  const bareHost = host.replace(/^www\./, "");
  if (!SEARCH_ENGINE_HOSTS.has(host) && !SEARCH_ENGINE_HOSTS.has(bareHost)) return null;
  for (const name of SEARCH_PARAM_NAMES) {
    const value = parsed.searchParams.get(name);
    if (value && value.trim().length > 0) return cleanQuery(value);
  }
  return null;
}

/**
 * True when the string starts with an explicit URL scheme. A bare `host:port`
 * (`localhost:3000/api`) is NOT a scheme — models write that constantly and it
 * means "read this local page", not "unsupported protocol".
 */
function hasScheme(raw: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https") return true;
  // `scheme:1234` where the rest is a port number → a bare host, not a scheme.
  if (/^\d+(\/|$)/.test(raw.slice(m[0].length))) return false;
  return true;
}

/** True when the string looks like a bare host (`example.com`, `127.0.0.1:8080`). */
function looksLikeHost(raw: string): boolean {
  if (/\s/.test(raw)) return false;
  const hostPart = raw.split("/")[0] ?? "";
  return hostPart.includes(".") || hostPart.startsWith("localhost") || /^\[?[0-9a-f:]+\]?$/i.test(hostPart);
}

/**
 * Classify one webfetch call. `query` (explicit) always wins; otherwise `url` is
 * inspected as described above.
 */
export function planRequest(input: { url?: string; query?: string }): WebFetchPlan {
  const explicitQuery = cleanQuery(input.query ?? "");
  if (explicitQuery.length > 0) {
    if (explicitQuery.length > MAX_QUERY_LENGTH) {
      return { mode: "error", message: `搜索词超过 ${MAX_QUERY_LENGTH} 个字符，请缩短后重试` };
    }
    return { mode: "search", query: explicitQuery };
  }

  const raw = (input.url ?? "").trim();
  if (raw.length === 0) {
    return { mode: "error", message: "webfetch: 需要 url（网页地址或搜索词）或 query（搜索词）" };
  }

  if (hasScheme(raw)) {
    const searchQuery = queryFromSearchUrl(raw);
    if (searchQuery) return { mode: "search", query: searchQuery };
    return { mode: "page", url: raw };
  }

  // No scheme: a bare host means page mode, anything else means a search.
  if (looksLikeHost(raw)) return { mode: "page", url: `https://${raw}` };

  const query = cleanQuery(raw);
  if (query.length > MAX_QUERY_LENGTH) {
    return { mode: "error", message: `搜索词超过 ${MAX_QUERY_LENGTH} 个字符，请缩短后重试` };
  }
  return { mode: "search", query };
}
