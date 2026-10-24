/**
 * Pure configuration loader for the webfetch extension.
 *
 * All knobs are read from environment variables with safe fallbacks. Parsing is
 * intentionally strict (digits only, must be > 0) so a malformed env value never
 * silently disables a limit — it falls back to the documented default instead.
 * Everything here is a pure function of an injectable `env` map, so it is
 * trivially unit-testable without touching `process.env`.
 */

/** Version tag baked into the User-Agent. Bump alongside package.json. */
export const WEBFETCH_VERSION = "0.2.0";

/** 10 MB — hard cap on bytes read into memory from any single response. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** 100 000 chars — cap on the markdown/text handed back to the model. */
export const DEFAULT_MAX_CHARS = 100_000;
/** 15 minutes — self-cleaning URL cache TTL. */
export const DEFAULT_CACHE_MS = 15 * 60 * 1000;
/** 60 seconds — per-request fetch timeout (resets on each permitted redirect). */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Default User-Agent. `+url` points site operators at a contact/info page. */
export const DEFAULT_USER_AGENT = `pi-webfetch/${WEBFETCH_VERSION} (+https://github.com/earendil-works/pi)`;

/** DeepSeek API base URL. Search/Fetch live under `<base>/v1/tools/{search,fetch}`. */
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** DeepSeek Search default result count. The API allows 1–50 (its own default is 10). */
export const DEFAULT_SEARCH_COUNT = 8;
/** DeepSeek Search caps a single query at 128 characters. */
export const MAX_SEARCH_QUERY_LENGTH = 128;
/** Per-result cap on `content` when `need_content` is requested, in characters. */
export const DEFAULT_SEARCH_CONTENT_CHARS = 2_000;
/** How page mode decides between the local fetch pipeline and DeepSeek Fetch. */
export type DeepSeekFetchMode = "auto" | "always" | "off";

/** Resolved runtime configuration consumed by the fetch pipeline. */
export interface WebFetchConfig {
  /** Max bytes read from a response body before truncation. */
  maxBytes: number;
  /** Max characters of extracted text returned to the model. */
  maxChars: number;
  /** URL cache TTL in milliseconds. */
  cacheMs: number;
  /** Per-request fetch timeout in milliseconds. */
  timeoutMs: number;
  /** User-Agent header sent with every request. */
  userAgent: string;
  /** DeepSeek API base URL (search/fetch tools live under `/v1/tools/*`). */
  deepseekBaseUrl: string;
  /**
   * DeepSeek API key. `undefined` disables web search entirely and disables the
   * DeepSeek Fetch fallback for page mode — the local pipeline keeps working.
   */
  deepseekApiKey?: string;
  /** Default number of search results to request (clamped to 1–50). */
  searchCount: number;
  /** Whether search results should embed page content by default. */
  searchNeedContent: boolean;
  /** Per-result `content` character cap when content is requested. */
  searchContentChars: number;
  /**
   * Page-mode extraction strategy:
   *   - `auto`   (default) local fetch first, DeepSeek Fetch only as a fallback
   *              when the local pipeline cannot produce readable text.
   *   - `always` DeepSeek Fetch first (handles JS-rendered pages), local fetch
   *              as the fallback when DeepSeek fails.
   *   - `off`    never call DeepSeek Fetch; page mode is purely local.
   */
  deepseekFetch: DeepSeekFetchMode;
}

/** Parse a strictly-positive integer; anything else returns `fallback`. */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  // Reject signs, decimals, and junk — only a run of digits is accepted.
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  return value > 0 ? value : fallback;
}

/** Parse a strictly-positive integer and clamp it into `[min, max]`. */
export function parseClampedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = parsePositiveInt(raw, fallback);
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Parse a boolean-ish env value (`1/true/yes/on` vs `0/false/no/off`). */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** Parse the page-mode extraction strategy; unknown values fall back to `auto`. */
export function parseDeepSeekFetchMode(raw: string | undefined, fallback: DeepSeekFetchMode = "auto"): DeepSeekFetchMode {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "always" || v === "auto" || v === "off" ? v : fallback;
}

/** Trim a string env value, returning undefined when empty/absent. */
function nonEmpty(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * Build the effective config from an environment map.
 *
 *   - `PI_WEBFETCH_MAX_BYTES`          → maxBytes          (default 10 MB)
 *   - `PI_WEBFETCH_MAX_CHARS`          → maxChars          (default 100 000)
 *   - `PI_WEBFETCH_CACHE_MS`           → cacheMs           (default 900 000)
 *   - `PI_WEBFETCH_TIMEOUT_MS`         → timeoutMs         (default 60 000)
 *   - `PI_WEBFETCH_USER_AGENT`         → userAgent         (default pi-webfetch/<ver>)
 *   - `DEEPSEEK_API_KEY`               → deepseekApiKey    (no default; absent = search off)
 *   - `PI_WEBFETCH_DEEPSEEK_API_KEY`   → deepseekApiKey    (overrides DEEPSEEK_API_KEY)
 *   - `DEEPSEEK_BASE_URL`              → deepseekBaseUrl   (default https://api.deepseek.com)
 *   - `PI_WEBFETCH_SEARCH_COUNT`       → searchCount       (default 8, clamped 1–50)
 *   - `PI_WEBFETCH_SEARCH_NEED_CONTENT`→ searchNeedContent (default false)
 *   - `PI_WEBFETCH_SEARCH_CONTENT_CHARS`→ searchContentChars (default 2 000)
 *   - `PI_WEBFETCH_DEEPSEEK_FETCH`     → deepseekFetch     (auto | always | off, default auto)
 */
export function loadWebFetchConfig(env: Record<string, string | undefined> = process.env): WebFetchConfig {
  const ua = env.PI_WEBFETCH_USER_AGENT?.trim();
  return {
    maxBytes: parsePositiveInt(env.PI_WEBFETCH_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxChars: parsePositiveInt(env.PI_WEBFETCH_MAX_CHARS, DEFAULT_MAX_CHARS),
    cacheMs: parsePositiveInt(env.PI_WEBFETCH_CACHE_MS, DEFAULT_CACHE_MS),
    timeoutMs: parsePositiveInt(env.PI_WEBFETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    userAgent: ua && ua.length > 0 ? ua : DEFAULT_USER_AGENT,
    deepseekBaseUrl: nonEmpty(env.PI_WEBFETCH_DEEPSEEK_BASE_URL) ?? nonEmpty(env.DEEPSEEK_BASE_URL) ?? DEFAULT_DEEPSEEK_BASE_URL,
    deepseekApiKey: nonEmpty(env.PI_WEBFETCH_DEEPSEEK_API_KEY) ?? nonEmpty(env.DEEPSEEK_API_KEY),
    searchCount: parseClampedInt(env.PI_WEBFETCH_SEARCH_COUNT, DEFAULT_SEARCH_COUNT, 1, 50),
    searchNeedContent: parseBool(env.PI_WEBFETCH_SEARCH_NEED_CONTENT, false),
    searchContentChars: parsePositiveInt(env.PI_WEBFETCH_SEARCH_CONTENT_CHARS, DEFAULT_SEARCH_CONTENT_CHARS),
    deepseekFetch: parseDeepSeekFetchMode(env.PI_WEBFETCH_DEEPSEEK_FETCH, "auto"),
  };
}

/** True when DeepSeek web search is usable (an API key is configured). */
export function isSearchEnabled(config: WebFetchConfig): boolean {
  return typeof config.deepseekApiKey === "string" && config.deepseekApiKey.length > 0;
}
