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
export const WEBFETCH_VERSION = "0.1.0";

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

/**
 * Build the effective config from an environment map.
 *
 *   - `PI_WEBFETCH_MAX_BYTES`   → maxBytes   (default 10 MB)
 *   - `PI_WEBFETCH_MAX_CHARS`   → maxChars   (default 100 000)
 *   - `PI_WEBFETCH_CACHE_MS`    → cacheMs    (default 900 000)
 *   - `PI_WEBFETCH_TIMEOUT_MS`  → timeoutMs  (default 60 000)
 *   - `PI_WEBFETCH_USER_AGENT`  → userAgent  (default pi-webfetch/<ver>)
 */
export function loadWebFetchConfig(env: Record<string, string | undefined> = process.env): WebFetchConfig {
  const ua = env.PI_WEBFETCH_USER_AGENT?.trim();
  return {
    maxBytes: parsePositiveInt(env.PI_WEBFETCH_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxChars: parsePositiveInt(env.PI_WEBFETCH_MAX_CHARS, DEFAULT_MAX_CHARS),
    cacheMs: parsePositiveInt(env.PI_WEBFETCH_CACHE_MS, DEFAULT_CACHE_MS),
    timeoutMs: parsePositiveInt(env.PI_WEBFETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    userAgent: ua && ua.length > 0 ? ua : DEFAULT_USER_AGENT,
  };
}
